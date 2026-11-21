import { mkdir, unlink, writeFile } from "node:fs/promises";
import type { HistoryWho } from "../history/historyLog";
import { HttpError } from "../../shared/errors";
import { PROJECT_FONT_DIR } from "../../shared/fonts";
import type { FontsAdded } from "../../shared/fonts";
import type { Project } from "../../shared/project";
import { projectWritePath } from "../projects/path";
import type { ReviewService } from "../projects/review";
import { readSource } from "../projects/store";
import type { ProjectStore } from "../projects/store";
import { declaredFonts } from "../timeline/titles";
import type { FontFace } from "./fontFile";

/** The one style block Cutroom writes added fonts into; the rest of index.html stays the author's. */
const FONT_BLOCK =
  /<style\b[^>]*\bdata-cutroom-fonts\b[^>]*>([\s\S]*?)<\/style>/i;

/** A face's file name without extension, such as Inter-700 or Oswald-var. */
export const fontFileStem = (face: FontFace) =>
  `${face.family.replace(/[^A-Za-z0-9]+/g, "")}-${typeof face.weight === "number" ? face.weight : "var"}${face.style === "italic" ? "Italic" : ""}`;

/**
 * An @font-face rule built from parsed values only: the family passed the font-family schema and
 * the path is Cutroom's own file name, so neither can carry a quote, a url() or markup.
 */
export const fontFaceRule = (face: FontFace, path: string) =>
  `@font-face {
  font-family: "${face.family}";
  src: url("${path}") format("${face.format}");
  font-weight: ${typeof face.weight === "number" ? face.weight : face.weight.join(" ")};
  font-style: ${face.style};
  font-display: block;
}`;

/** index.html with `rules` appended to Cutroom's font block, which is added to the head if missing. */
export function withFontRules(html: string, rules: readonly string[]) {
  const block = FONT_BLOCK.exec(html);
  if (block)
    return html.replace(
      block[0],
      () =>
        `<style data-cutroom-fonts>\n${[block[1]!.trim(), ...rules].filter(Boolean).join("\n")}\n</style>`,
    );
  const style = `<style data-cutroom-fonts>\n${rules.join("\n")}\n</style>\n`;
  const at = /<\/head\s*>|<body\b/i.exec(html);
  if (!at)
    throw new HttpError(
      409,
      "index.html has no head or body to declare fonts in.",
    );
  return `${html.slice(0, at.index)}${style}${html.slice(at.index)}`;
}

/** Families index.html declares outside Cutroom's font block, which an added font must not shadow. */
const authoredFamilies = (html: string) =>
  new Set(
    declaredFonts(html.replace(FONT_BLOCK, "")).map((family) =>
      family.toLowerCase(),
    ),
  );

/** Whether index.html already loads this face from the file Cutroom would give it. */
export const hasFontFile = (html: string, face: FontFace) =>
  (FONT_BLOCK.exec(html)?.[1] ?? "").includes(
    `url("${PROJECT_FONT_DIR}/${fontFileStem(face)}.${face.extension}")`,
  );

/**
 * Copies each face into the project's font folder under a new name and declares it in index.html,
 * as one undo step. A failure removes every file this call wrote, so nothing is left half-added.
 */
export async function addFontFaces(
  store: ProjectStore,
  reviews: ReviewService,
  project: Project,
  faces: readonly (FontFace & { bytes: Uint8Array })[],
  token: string | undefined,
  who: HistoryWho | undefined,
): Promise<FontsAdded> {
  const families = [...new Set(faces.map((face) => face.family))];
  return reviews.editComposition(project, "index.html", token, () =>
    store.mutate(
      project,
      `Add ${families.length === 1 ? "font" : "fonts"} ${families.join(", ")}`,
      async () => {
        const source = await readSource(project, "index.html");
        const authored = authoredFamilies(source.content);
        const taken = families.find((family) =>
          authored.has(family.toLowerCase()),
        );
        if (taken)
          throw new HttpError(409, `${taken} is already in this project.`);
        const directory = await projectWritePath(project, PROJECT_FONT_DIR, {
          allowMissing: true,
          sourceOnly: false,
        });
        await mkdir(directory, { recursive: true });
        const written: string[] = [];
        try {
          const rules: string[] = [];
          const files: string[] = [];
          for (const face of faces) {
            for (let copy = 1; ; copy++) {
              const path = `${PROJECT_FONT_DIR}/${fontFileStem(face)}${copy === 1 ? "" : `-${copy}`}.${face.extension}`;
              const absolute = await projectWritePath(project, path, {
                allowMissing: true,
                sourceOnly: false,
              });
              const created = await writeFile(absolute, face.bytes, {
                flag: "wx",
              }).then(
                () => true,
                (error: unknown) => {
                  if (
                    error instanceof Error &&
                    "code" in error &&
                    error.code === "EEXIST"
                  )
                    return false;
                  throw error;
                },
              );
              if (!created) continue;
              written.push(absolute);
              files.push(path);
              rules.push(fontFaceRule(face, path));
              break;
            }
          }
          store.writeFiles(project, [
            {
              sourceFile: "index.html",
              absPath: await projectWritePath(project, "index.html"),
              before: source.content,
              after: withFontRules(source.content, rules),
              expectedVersion: source.version,
            },
          ]);
          return { families, files };
        } catch (error) {
          await Promise.all(
            written.map((path) => unlink(path).catch(() => {})),
          );
          throw error;
        }
      },
      who,
    ),
  );
}
