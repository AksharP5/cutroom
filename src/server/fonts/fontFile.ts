import { brotliDecompressSync, inflateSync } from "node:zlib";
import { HttpError } from "../../shared/errors";
import { FONT_FILE_BYTES } from "../../shared/fonts";
import { fontFamily } from "../../shared/timeline/elementStyle";

export type FontFormat = "truetype" | "opentype" | "woff" | "woff2";

/** What an @font-face rule needs to know about one font file. */
export type FontFace = {
  family: string;
  /** One weight, or the range a variable font's wght axis covers. */
  weight: number | readonly [number, number];
  style: "normal" | "italic";
  format: FontFormat;
  extension: "ttf" | "otf" | "woff" | "woff2";
};

const notAFont = () =>
  new HttpError(400, "Not a TrueType, OpenType, WOFF or WOFF2 font.");

/** Decompressed tables may not grow past this, whatever a header claims. */
const MAX_DECOMPRESSED = 4 * FONT_FILE_BYTES;

/** WOFF2's table tags by index, from the WOFF2 specification. */
const WOFF2_TAGS = [
  "cmap",
  "head",
  "hhea",
  "hmtx",
  "maxp",
  "name",
  "OS/2",
  "post",
  "cvt ",
  "fpgm",
  "glyf",
  "loca",
  "prep",
  "CFF ",
  "VORG",
  "EBDT",
  "EBLC",
  "gasp",
  "hdmx",
  "kern",
  "LTSH",
  "PCLT",
  "VDMX",
  "vhea",
  "vmtx",
  "BASE",
  "GDEF",
  "GPOS",
  "GSUB",
  "EBSC",
  "JSTF",
  "MATH",
  "CBDT",
  "CBLC",
  "COLR",
  "CPAL",
  "SVG ",
  "sbix",
  "acnt",
  "avar",
  "bdat",
  "bloc",
  "bsln",
  "cvar",
  "fdsc",
  "feat",
  "fmtx",
  "fvar",
  "gvar",
  "hsty",
  "just",
  "lcar",
  "mort",
  "morx",
  "opbd",
  "prop",
  "trak",
  "Zapf",
  "Silf",
  "Glat",
  "Gloc",
  "Feat",
  "Sill",
];
const WANTED = new Set(["name", "OS/2", "fvar"]);

type Tables = Map<string, Buffer>;

function slice(file: Buffer, offset: number, length: number) {
  if (offset + length > file.length) throw notAFont();
  return file.subarray(offset, offset + length);
}

function sfntTables(file: Buffer): Tables {
  const count = file.readUInt16BE(4);
  const tables: Tables = new Map();
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    const tag = slice(file, at, 16).toString("latin1", 0, 4);
    if (WANTED.has(tag))
      tables.set(
        tag,
        slice(file, file.readUInt32BE(at + 8), file.readUInt32BE(at + 12)),
      );
  }
  return tables;
}

function woffTables(file: Buffer): Tables {
  const count = file.readUInt16BE(12);
  const tables: Tables = new Map();
  for (let i = 0; i < count; i++) {
    const at = 44 + i * 20;
    const tag = slice(file, at, 20).toString("latin1", 0, 4);
    if (!WANTED.has(tag)) continue;
    const data = slice(
      file,
      file.readUInt32BE(at + 4),
      file.readUInt32BE(at + 8),
    );
    const length = file.readUInt32BE(at + 12);
    tables.set(
      tag,
      data.length < length
        ? inflateSync(data, { maxOutputLength: MAX_DECOMPRESSED })
        : data,
    );
  }
  return tables;
}

function woff2Tables(file: Buffer): Tables {
  if (file.toString("latin1", 4, 8) === "ttcf")
    throw new HttpError(400, "Font collections cannot be imported.");
  const count = file.readUInt16BE(12);
  const compressed = file.readUInt32BE(20);
  let at = 48;
  const base128 = () => {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = slice(file, at++, 1)[0]!;
      value = value * 128 + (byte & 0x7f);
      if (!(byte & 0x80)) return value;
    }
    throw notAFont();
  };
  const entries: { tag: string; length: number }[] = [];
  for (let i = 0; i < count; i++) {
    const flags = slice(file, at++, 1)[0]!;
    const known = flags & 0x3f;
    let tag = WOFF2_TAGS[known];
    if (known === 0x3f) {
      tag = slice(file, at, 4).toString("latin1");
      at += 4;
    }
    if (tag === undefined) throw notAFont();
    const original = base128();
    const version = flags >> 6;
    // glyf and loca are transformed at version 0; every other table at any other version.
    const transformed = ["glyf", "loca"].includes(tag)
      ? version === 0
      : version !== 0;
    entries.push({ tag, length: transformed ? base128() : original });
  }
  const stream = brotliDecompressSync(slice(file, at, compressed), {
    maxOutputLength: MAX_DECOMPRESSED,
  });
  const tables: Tables = new Map();
  let offset = 0;
  for (const { tag, length } of entries) {
    if (WANTED.has(tag)) tables.set(tag, slice(stream, offset, length));
    offset += length;
  }
  return tables;
}

/** Name IDs 16 and 1: the typographic family first, so "Inter SemiBold" reads as Inter. */
function familyName(name: Buffer | undefined): string | undefined {
  if (!name || name.length < 6) return undefined;
  const count = name.readUInt16BE(2);
  const strings = name.readUInt16BE(4);
  const found: { id: number; rank: number; text: string }[] = [];
  for (let i = 0; i < count && 6 + i * 12 + 12 <= name.length; i++) {
    const at = 6 + i * 12;
    const platform = name.readUInt16BE(at);
    const language = name.readUInt16BE(at + 4);
    const id = name.readUInt16BE(at + 6);
    if (id !== 16 && id !== 1) continue;
    const start = strings + name.readUInt16BE(at + 10);
    const raw = name.subarray(start, start + name.readUInt16BE(at + 8));
    // Windows (3) and Unicode (0) names are UTF-16BE; Macintosh (1) names are single-byte.
    const text =
      platform === 1
        ? raw.toString("latin1")
        : Buffer.from(raw).swap16().toString("utf16le");
    const rank =
      platform === 3 && language === 0x409 ? 0 : platform === 1 ? 2 : 1;
    found.push({ id, rank, text });
  }
  found.sort((a, b) => b.id - a.id || a.rank - b.rank);
  return found.map((entry) => cleanFamily(entry.text)).find(Boolean);
}

/** A family as the font menu and the title schema accept it, or undefined when none is left. */
export function cleanFamily(text: string): string | undefined {
  const cleaned = text
    .replace(/[^A-Za-z0-9 _-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[ _-]+|[ _-]+$/g, "")
    .slice(0, 100)
    .trim();
  return fontFamily.safeParse(cleaned).success ? cleaned : undefined;
}

function weightOf(tables: Tables): FontFace["weight"] {
  const fvar = tables.get("fvar");
  if (fvar && fvar.length >= 16) {
    const axes = fvar.readUInt16BE(4);
    const count = fvar.readUInt16BE(8);
    const size = fvar.readUInt16BE(10);
    for (let i = 0; i < count; i++) {
      const at = axes + i * size;
      if (at + 20 > fvar.length) break;
      if (fvar.toString("latin1", at, at + 4) !== "wght") continue;
      const min = clampWeight(fvar.readInt32BE(at + 4) / 65536);
      const max = clampWeight(fvar.readInt32BE(at + 12) / 65536);
      return min === max ? min : [min, max];
    }
  }
  const os2 = tables.get("OS/2");
  return os2 && os2.length >= 6 ? clampWeight(os2.readUInt16BE(4)) : 400;
}

const clampWeight = (value: number) =>
  Math.min(1000, Math.max(1, Math.round(value)));

const FORMATS: Record<string, [FontFormat, FontFace["extension"]]> = {
  "\0\x01\0\0": ["truetype", "ttf"],
  true: ["truetype", "ttf"],
  OTTO: ["opentype", "otf"],
  wOFF: ["woff", "woff"],
  wOF2: ["woff2", "woff2"],
};

/**
 * Reads a font file's family, weight and style from its own tables, after checking its signature.
 * `fallbackFamily` names a font whose tables carry no usable family, such as one from its file name.
 */
export function readFontFile(
  bytes: Uint8Array,
  fallbackFamily?: string,
): FontFace {
  if (bytes.length > FONT_FILE_BYTES)
    throw new HttpError(413, "Font files are limited to 20 MB.");
  const file = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (file.length < 48) throw notAFont();
  const signature = FORMATS[file.toString("latin1", 0, 4)];
  if (!signature) throw notAFont();
  const [format, extension] = signature;
  let tables: Tables;
  try {
    tables =
      format === "woff2"
        ? woff2Tables(file)
        : format === "woff"
          ? woffTables(file)
          : sfntTables(file);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw notAFont();
  }
  if (!tables.has("name")) throw notAFont();
  const family =
    familyName(tables.get("name")) ??
    (fallbackFamily && cleanFamily(fallbackFamily));
  if (!family)
    throw new HttpError(
      400,
      "The font names no family Cutroom can use. Rename the file to the family's name and import it again.",
    );
  const os2 = tables.get("OS/2");
  // fsSelection bit 0 is italic and bit 9 oblique; both read as italic to CSS.
  const italic =
    os2 && os2.length >= 64 && (os2.readUInt16BE(62) & 0x201) !== 0;
  return {
    family,
    weight: weightOf(tables),
    style: italic ? "italic" : "normal",
    format,
    extension,
  };
}
