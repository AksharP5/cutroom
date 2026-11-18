import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, posix } from "node:path";
import { bakeHfColorGradingCube } from "@hyperframes/core";
import { CubeLutParseError, parseCubeLut } from "@hyperframes/core/color-luts";
import type { CubeLut3D } from "@hyperframes/core/color-luts";
import { HttpError } from "../../shared/errors.ts";
import type { Project } from "../../shared/project.ts";
import { LUT_DIRECTORY, LutPathSchema } from "../../shared/timeline/grade.ts";
import type { Grade, LutInfo } from "../../shared/timeline/grade.ts";
import {
  isMissing,
  projectPath,
  projectWritePath,
  resolveProjectPath,
} from "../projects/path.ts";

/** A 65-point cube written out is about 7 MB; anything past this is not a colour LUT. */
export const LUT_FILE_BYTES = 16 * 1024 * 1024;
/** Points per axis HyperFrames' runtime reads, and Resolve's largest common size. */
export const LUT_MAX_SIZE = 65;
/** Domain and output values a colour LUT can sensibly hold; log and wide-range LUTs stay inside. */
const LUT_VALUE_LIMIT = 4;
/** The sizes Cutroom bakes: Resolve and FFmpeg read both. */
export const BAKE_SIZES = [33, 65] as const;

/**
 * A `.cube` file read as untrusted input: bounded in bytes, strict UTF-8, one 3D table of at most
 * 65 points per axis with every value finite and within ±4. Errors name the line, never echo it.
 */
export function readCube(bytes: Uint8Array): CubeLut3D {
  if (bytes.byteLength > LUT_FILE_BYTES)
    throw new HttpError(413, "A .cube LUT must be smaller than 16 MB.");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(400, "That .cube file is not text.");
  }
  let lut: CubeLut3D;
  try {
    lut = parseCubeLut(text, { maxSize: LUT_MAX_SIZE });
  } catch (error) {
    if (!(error instanceof CubeLutParseError)) throw error;
    const at = error.lineNumber ? ` (line ${error.lineNumber})` : "";
    const reason = error.message
      .replace(/ at line \d+$/, "")
      .replace(/"[^"]*"/g, "a value");
    throw new HttpError(400, `That .cube file cannot be read${at}: ${reason}.`);
  }
  const values = [...lut.domainMin, ...lut.domainMax, ...lut.data];
  if (values.some((value) => Math.abs(value) > LUT_VALUE_LIMIT))
    throw new HttpError(
      400,
      `That .cube file has values beyond ±${LUT_VALUE_LIMIT}, which no colour LUT needs.`,
    );
  return lut;
}

/** One canonical form, so the project holds exactly what was checked and nothing else. */
export function writeCube(lut: CubeLut3D, title: string) {
  const vector = (values: readonly number[]) =>
    values.map((value) => value.toFixed(6)).join(" ");
  const lines = [
    `TITLE "${title}"`,
    `LUT_3D_SIZE ${lut.size}`,
    `DOMAIN_MIN ${vector(lut.domainMin)}`,
    `DOMAIN_MAX ${vector(lut.domainMax)}`,
  ];
  for (let index = 0; index < lut.data.length; index += 3)
    lines.push(vector(Array.from(lut.data.subarray(index, index + 3))));
  return `${lines.join("\n")}\n`;
}

/** A title and file stem from a name a person or agent gave: words, digits, spaces and dashes. */
function lutName(name: string) {
  const title =
    name
      .replace(/\.cube$/i, "")
      .replace(/[^\p{L}\p{N} _-]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60) || "LUT";
  const stem =
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "lut";
  return { title, stem };
}

/** Writes a checked LUT into the project's luts folder under a fresh name; returns its path. */
export async function saveLut(
  project: Pick<Project, "path">,
  name: string,
  lut: CubeLut3D,
): Promise<LutInfo> {
  const { title, stem } = lutName(name);
  const directory = await projectWritePath(project, LUT_DIRECTORY, {
    allowMissing: true,
    sourceOnly: false,
  });
  await mkdir(directory, { recursive: true });
  const content = writeCube(lut, title);
  for (let copy = 1; copy < 1000; copy++) {
    const path = `${LUT_DIRECTORY}/${stem}${copy === 1 ? "" : `-${copy}`}.cube`;
    const absolute = await projectWritePath(project, path, {
      allowMissing: true,
      sourceOnly: false,
    });
    const created = await writeFile(absolute, content, { flag: "wx" }).then(
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
    if (created) return { path, title, size: lut.size };
  }
  throw new HttpError(
    409,
    `The project already has too many LUTs named ${title}.`,
  );
}

/** A LUT from a file on this computer, which only an owner-approved call may read. */
export async function importLutFile(
  project: Pick<Project, "path">,
  path: string,
) {
  if (!isAbsolute(path) || !/\.cube$/i.test(path))
    throw new HttpError(400, "Name a .cube file by its full path.");
  const info = await stat(path).catch((error: unknown) => {
    if (isMissing(error))
      throw new HttpError(404, "That .cube file does not exist.");
    throw error;
  });
  if (!info.isFile()) throw new HttpError(400, "That path is not a file.");
  if (info.size > LUT_FILE_BYTES)
    throw new HttpError(413, "A .cube LUT must be smaller than 16 MB.");
  return saveLut(project, basename(path), readCube(await readFile(path)));
}

/** A project LUT, named relative to the composition file as its grade names it. */
export async function readProjectLutBytes(
  project: Pick<Project, "path">,
  composition: string,
  src: string,
) {
  const path = posix.join(posix.dirname(composition), src);
  const resolved = await resolveProjectPath(project, path).catch(() => {
    throw new HttpError(404, `The LUT ${src} is not in the project.`);
  });
  if (!LutPathSchema.safeParse(resolved.path).success)
    throw new HttpError(404, `The LUT ${src} is not in the project.`);
  const info = await stat(resolved.absolute);
  if (!info.isFile() || info.size > LUT_FILE_BYTES)
    throw new HttpError(
      400,
      `The LUT ${src} is not a .cube file Cutroom reads.`,
    );
  return readFile(resolved.absolute);
}

export async function readProjectLut(
  project: Pick<Project, "path">,
  composition: string,
  src: string,
) {
  return readCube(await readProjectLutBytes(project, composition, src));
}

/** The project's LUTs: every readable `.cube` in its luts folder. */
export async function listLuts(project: Pick<Project, "path">) {
  const directory = await projectPath(project, LUT_DIRECTORY).catch(() => null);
  if (!directory) return [];
  const names = (await readdir(directory).catch(() => [])).filter(
    (name) => !name.startsWith(".") && /\.cube$/i.test(name),
  );
  const luts: LutInfo[] = [];
  for (const name of names.sort()) {
    const path = `${LUT_DIRECTORY}/${name}`;
    try {
      const lut = readCube(await readFile(await projectPath(project, path)));
      luts.push({ path, title: lut.title, size: lut.size });
    } catch {
      // A broken or foreign file is left alone; importing it would say why.
    }
  }
  return luts;
}

/**
 * The grade as a `.cube` that matches HyperFrames' shader, for FFmpeg's lut3d and other editors.
 * The grade's own LUT is read from the project, relative to its composition.
 */
export async function bakeGrade(
  project: Pick<Project, "path">,
  composition: string,
  grade: Grade,
  size: (typeof BAKE_SIZES)[number],
) {
  const lut = grade.lut
    ? await readProjectLut(project, composition, grade.lut.src)
    : null;
  return bakeHfColorGradingCube(grade, { size, lut });
}

/** Writes a baked grade where FFmpeg reads it during an export. */
export async function writeBakedGrade(path: string, cube: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, cube);
}
