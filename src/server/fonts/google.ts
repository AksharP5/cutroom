import { z } from "zod";
import { HttpError } from "../../shared/errors";
import { FONT_FILE_BYTES, GOOGLE_FONT_WEIGHTS } from "../../shared/fonts";
import type { GoogleFamily, GoogleFontWeight } from "../../shared/fonts";
import { fontFamily } from "../../shared/timeline/elementStyle";
import { readFontFile } from "./fontFile";
import type { FontFace } from "./fontFile";

/**
 * Google Fonts' own catalogue and CSS API. These two hosts and fonts.gstatic.com are the only ones
 * this module reaches; every URL is built here or checked against an exact pattern before a fetch.
 */
const METADATA_URL = "https://fonts.google.com/metadata/fonts";
const CSS_URL = "https://fonts.googleapis.com/css2";
const FILE_URL =
  /^https:\/\/fonts\.gstatic\.com\/s\/[a-z0-9]+\/v\d+\/[A-Za-z0-9_-]+\.ttf$/;
const METADATA_BYTES = 16 * 1024 * 1024;
const CSS_BYTES = 256 * 1024;

const unreachable = () =>
  new HttpError(
    502,
    "Couldn't reach Google Fonts. Check your connection and try again.",
  );

const MetadataSchema = z.object({
  familyMetadataList: z.array(
    z.object({
      family: z.string(),
      category: z.string().catch(""),
      popularity: z.number().catch(Number.MAX_SAFE_INTEGER),
      fonts: z.record(z.string(), z.unknown()),
    }),
  ),
});

/** A response body read up to `limit` bytes, so no reply can grow without bound. */
async function readCapped(response: Response, limit: number) {
  const declared = Number(response.headers.get("content-length"));
  if (declared > limit) throw unreachable();
  if (!response.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) throw unreachable();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** One `@font-face` of Google's CSS, as the three values Cutroom reads from it. */
export function parseGoogleCss(css: string) {
  return [...css.matchAll(/@font-face\s*\{([^{}]*)\}/g)].map(([, body]) => ({
    style: /font-style:\s*([a-z]+);/.exec(body!)?.[1],
    weight: Number(/font-weight:\s*(\d+);/.exec(body!)?.[1]),
    url: /src:\s*url\(([^)\s'"]+)\)\s*format\('truetype'\);/.exec(body!)?.[1],
  }));
}

export type DownloadedFace = FontFace & { bytes: Uint8Array };

/** `fetchImpl` is the only way out to the network, so tests can stand in for Google. */
export function createGoogleFonts(fetchImpl: typeof fetch = fetch) {
  let catalogue: Promise<GoogleFamily[]> | undefined;

  const get = async (url: string, limit: number, timeout: number) => {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        // A plain agent gets one whole TrueType file per weight instead of per-script subsets.
        headers: { "user-agent": "Cutroom" },
        redirect: "error",
        signal: AbortSignal.timeout(timeout),
      });
    } catch {
      throw unreachable();
    }
    if (!response.ok) throw unreachable();
    return {
      type: response.headers.get("content-type") ?? "",
      body: await readCapped(response, limit).catch(() => {
        throw unreachable();
      }),
    };
  };

  const load = async () => {
    const { body } = await get(METADATA_URL, METADATA_BYTES, 15_000);
    const text = new TextDecoder().decode(body);
    let json: unknown;
    try {
      // The reply opens with an anti-JSON-hijacking prefix.
      json = JSON.parse(text.slice(text.indexOf("{")));
    } catch {
      throw unreachable();
    }
    const parsed = MetadataSchema.safeParse(json);
    if (!parsed.success) throw unreachable();
    return parsed.data.familyMetadataList
      .toSorted((a, b) => a.popularity - b.popularity)
      .flatMap((entry) => {
        const weights = GOOGLE_FONT_WEIGHTS.filter((weight) =>
          Object.hasOwn(entry.fonts, String(weight)),
        );
        return fontFamily.safeParse(entry.family).success && weights.length
          ? [{ family: entry.family, category: entry.category, weights }]
          : [];
      });
  };

  /** Every family Google Fonts offers, most popular first. A failed read is retried next time. */
  const families = () => {
    catalogue ??= load().catch((error: unknown) => {
      catalogue = undefined;
      throw error;
    });
    return catalogue;
  };

  return {
    families,
    /** Downloads one TrueType file per weight, each checked to be a font of the expected size. */
    async download(
      family: string,
      weights: readonly GoogleFontWeight[],
    ): Promise<DownloadedFace[]> {
      const entry = (await families()).find((item) => item.family === family);
      if (!entry)
        throw new HttpError(404, `Google Fonts has no family named ${family}.`);
      const missing = weights.filter(
        (weight) => !entry.weights.includes(weight),
      );
      if (missing.length)
        throw new HttpError(
          400,
          `${family} has no weight ${missing.join(", ")}. Its weights are ${entry.weights.join(", ")}.`,
        );
      // Family names hold only letters, digits, spaces, hyphens and underscores.
      const css = await get(
        `${CSS_URL}?family=${family.replaceAll(" ", "+")}:wght@${weights.join(";")}`,
        CSS_BYTES,
        15_000,
      );
      if (!css.type.startsWith("text/css")) throw unreachable();
      const faces = parseGoogleCss(new TextDecoder().decode(css.body));
      return Promise.all(
        weights.map(async (weight) => {
          const url = faces.find(
            (face) => face.style === "normal" && face.weight === weight,
          )?.url;
          if (!url || !FILE_URL.test(url)) throw unreachable();
          const file = await get(url, FONT_FILE_BYTES, 60_000);
          if (file.type !== "font/ttf") throw unreachable();
          let face: FontFace;
          try {
            face = readFontFile(file.body);
          } catch {
            throw unreachable();
          }
          if (face.format !== "truetype") throw unreachable();
          return { ...face, family, weight, style: "normal", bytes: file.body };
        }),
      );
    },
  };
}

export type GoogleFonts = ReturnType<typeof createGoogleFonts>;
