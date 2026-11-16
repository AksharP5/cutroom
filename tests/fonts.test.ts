import { afterEach, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { readFontFile } from "../src/server/fonts/fontFile";
import { createGoogleFonts } from "../src/server/fonts/google";
import { createFontRoutes } from "../src/server/fonts/routes";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import { projectFixture } from "./project-fixture";
import { blockFont } from "./test-font";

const metadata = `)]}'
${JSON.stringify({
  familyMetadataList: [
    {
      family: "Block Sans",
      category: "Sans Serif",
      popularity: 2,
      fonts: { "400": {}, "400i": {}, "700": {} },
    },
    {
      family: "Oswald",
      category: "Sans Serif",
      popularity: 1,
      fonts: { "400": {} },
    },
  ],
})}`;

const googleCss = (urls: Record<number, string>) =>
  Object.entries(urls)
    .map(
      ([weight, url]) => `@font-face {
  font-family: 'Block Sans';
  font-style: normal;
  font-weight: ${weight};
  src: url(${url}) format('truetype');
}`,
    )
    .join("\n");

const gstatic = (weight: number) =>
  `https://fonts.gstatic.com/s/blocksans/v1/block${weight}.ttf`;

/** Stands in for Google Fonts, recording every URL Cutroom asks for. */
function fakeGoogle(
  css = googleCss({ 400: gstatic(400), 700: gstatic(700) }),
  fail?: (url: string) => boolean,
) {
  const requests: string[] = [];
  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (fail?.(url)) throw new TypeError("fetch failed");
    if (url === "https://fonts.google.com/metadata/fonts")
      return new Response(metadata, {
        headers: { "content-type": "application/json" },
      });
    if (url.startsWith("https://fonts.googleapis.com/css2?"))
      return new Response(css, { headers: { "content-type": "text/css" } });
    const weight = /block(\d+)\.ttf$/.exec(url)?.[1];
    if (url.startsWith("https://fonts.gstatic.com/") && weight)
      return new Response(
        blockFont({ family: "Block Sans", weight: Number(weight) }),
        { headers: { "content-type": "font/ttf" } },
      );
    return new Response("not found", { status: 404 });
  };
  return { requests, fetch: fetchImpl as typeof fetch };
}

const closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closing.splice(0).map((close) => close()));
});

async function fontsFixture(google = fakeGoogle()) {
  const fixture = await projectFixture();
  closing.push(fixture.close);
  fixture.app.route(
    "/api/cutroom",
    createFontRoutes(
      fixture.store,
      fixture.review,
      createGoogleFonts(google.fetch),
    ),
  );
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  const project = await fixture.store.create({ name: "Fonts" });
  const url = `/api/cutroom/projects/${project.id}`;
  const index = () => readFile(join(project.path, "index.html"), "utf8");
  return {
    ...fixture,
    google,
    project,
    index,
    fontFiles: () => readdir(join(project.path, "assets/fonts")),
    addGoogle: (body: unknown) =>
      fixture.app.request(`${url}/fonts/google`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    importFiles: (files: File[]) => {
      const form = new FormData();
      for (const file of files) form.append("file", file);
      return fixture.app.request(`${url}/fonts/import`, {
        method: "POST",
        body: form,
      });
    },
    timelineFonts: async () =>
      (await (await fixture.app.request(`${url}/timeline`)).json()).timeline
        .fonts as string[],
  };
}

test("a Google font is downloaded once into assets/fonts and declared, so titles and text can use it at once", async () => {
  const fixture = await fontsFixture();
  const response = await fixture.addGoogle({
    family: "Block Sans",
    weights: [700, 400],
  });
  expect(await response.json()).toEqual({
    families: ["Block Sans"],
    files: ["assets/fonts/BlockSans-400.ttf", "assets/fonts/BlockSans-700.ttf"],
  });
  expect(await fixture.timelineFonts()).toContain("Block Sans");
  const html = await fixture.index();
  expect(html).toContain(`<style data-cutroom-fonts>
@font-face {
  font-family: "Block Sans";
  src: url("assets/fonts/BlockSans-400.ttf") format("truetype");
  font-weight: 400;
  font-style: normal;
  font-display: block;
}`);
  expect(
    readFontFile(
      await readFile(
        join(fixture.project.path, "assets/fonts/BlockSans-700.ttf"),
      ),
    ),
  ).toMatchObject({ family: "Block Sans", weight: 700 });
  expect(
    new Set(fixture.google.requests.map((url) => new URL(url).host)),
  ).toEqual(
    new Set(["fonts.google.com", "fonts.googleapis.com", "fonts.gstatic.com"]),
  );

  // Asking again downloads nothing: the weights are already in the project.
  const asked = fixture.google.requests.length;
  expect(
    (await fixture.addGoogle({ family: "Block Sans", weights: [400] })).status,
  ).toBe(200);
  expect(fixture.google.requests.length).toBe(asked);
  expect(await fixture.index()).toBe(html);
});

test("a Google reply naming a file anywhere but fonts.gstatic.com is never fetched and leaves the project as it was", async () => {
  const fixture = await fontsFixture(
    fakeGoogle(
      googleCss({
        400: gstatic(400),
        700: "https://127.0.0.1:4317/api/cutroom/projects/block700.ttf",
      }),
    ),
  );
  const before = await fixture.index();
  const fonts = await fixture.fontFiles();
  const response = await fixture.addGoogle({
    family: "Block Sans",
    weights: [400, 700],
  });
  expect(response.status).toBe(502);
  expect(fixture.google.requests.some((url) => url.includes("127.0.0.1"))).toBe(
    false,
  );
  expect(await fixture.index()).toBe(before);
  expect(await fixture.fontFiles()).toEqual(fonts);
});

test("offline, or a download failing part way, gives a plain error and writes nothing", async () => {
  for (const fail of [() => true, (url: string) => url === gstatic(700)]) {
    const fixture = await fontsFixture(fakeGoogle(undefined, fail));
    const before = await fixture.index();
    const fonts = await fixture.fontFiles();
    const response = await fixture.addGoogle({
      family: "Block Sans",
      weights: [400, 700],
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error:
        "Couldn't reach Google Fonts. Check your connection and try again.",
    });
    expect(await fixture.index()).toBe(before);
    expect(await fixture.fontFiles()).toEqual(fonts);
  }
});

test("a family the project already declares by hand is refused rather than shadowed", async () => {
  const fixture = await fontsFixture();
  const response = await fixture.addGoogle({
    family: "Oswald",
    weights: [400],
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: "Oswald is already in this project.",
  });
});

test("imported font files are declared with the family, weight and style their own tables name", async () => {
  const fixture = await fontsFixture();
  const response = await fixture.importFiles([
    new File([blockFont({ family: "Cutroom Block", weight: 700 })], "cb.ttf"),
    new File(
      [blockFont({ family: "Cutroom Block", italic: true })],
      "cb-it.ttf",
    ),
  ]);
  expect(await response.json()).toEqual({
    families: ["Cutroom Block"],
    files: [
      "assets/fonts/CutroomBlock-700.ttf",
      "assets/fonts/CutroomBlock-400Italic.ttf",
    ],
  });
  const html = await fixture.index();
  expect(html).toContain(
    'src: url("assets/fonts/CutroomBlock-400Italic.ttf") format("truetype");\n  font-weight: 400;\n  font-style: italic;',
  );
  expect(await fixture.timelineFonts()).toContain("Cutroom Block");
});

test("a font's own name cannot write markup or CSS into index.html, and a file that is not a font is refused", async () => {
  const fixture = await fontsFixture();
  await fixture.importFiles([
    new File(
      [blockFont({ family: 'Evil"}</style><script>alert(1)</script>' })],
      "evil.ttf",
    ),
  ]);
  const html = await fixture.index();
  expect(html).not.toContain("<script>alert");
  expect(html).toContain('font-family: "Evil style script alert 1 script";');

  const fonts = await fixture.fontFiles();
  const png = await fixture.importFiles([
    new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new Uint8Array(60)])],
      "logo.ttf",
    ),
  ]);
  expect(png.status).toBe(400);
  expect(await png.json()).toEqual({
    error: "logo.ttf: Not a TrueType, OpenType, WOFF or WOFF2 font.",
  });
  expect(await fixture.index()).toBe(html);
  expect(await fixture.fontFiles()).toEqual(fonts);
});

test("WOFF and WOFF2 files, variable ones included, read their family and weights", async () => {
  const read = async (path: string) =>
    readFontFile(new Uint8Array(await Bun.file(path).arrayBuffer()));
  expect(
    await read(
      new URL("../src/server/projects/fonts/Oswald-var.woff2", import.meta.url)
        .pathname,
    ),
  ).toEqual({
    family: "Oswald",
    weight: [200, 700],
    style: "normal",
    format: "woff2",
    extension: "woff2",
  });
  expect(
    await read(
      Bun.resolveSync(
        "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff",
        import.meta.dir,
      ),
    ),
  ).toMatchObject({ family: "IBM Plex Sans", weight: 400, format: "woff" });
});
