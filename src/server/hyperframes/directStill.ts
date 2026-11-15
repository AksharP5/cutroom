import { readFile } from "node:fs/promises";
import { projectPath } from "../projects/path.ts";
import { contentRect, coversFrame, visibleRect } from "./directPlacement.ts";
import type { DirectPlan } from "./directSchema.ts";

type Still = { width: number; height: number; translucent: boolean };

/**
 * A PNG's size, if the browser draws its pixels as stored: no colour profile, gamma or
 * chromaticities to convert, no EXIF orientation and no animation.
 */
function png(bytes: Buffer): Still | string {
  let translucent = false;
  let header: Omit<Still, "translucent"> | undefined;
  for (let at = 8; at + 8 <= bytes.length;) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    if (type === "IHDR") {
      header = {
        width: bytes.readUInt32BE(at + 8),
        height: bytes.readUInt32BE(at + 12),
      };
      // Grey with alpha, or colour with alpha.
      translucent ||= [4, 6].includes(bytes[at + 17]!);
    }
    if (
      ["iCCP", "cICP", "cHRM", "gAMA", "mDCv", "cLLi", "eXIf", "acTL"].includes(
        type,
      )
    )
      return `it has a ${type} chunk`;
    if (type === "tRNS") translucent = true;
    if (type === "IDAT")
      return header ? { ...header, translucent } : "it has no header";
    at += 12 + length;
  }
  return "it ends before its pixels";
}

/** The EXIF orientation in an APP1 segment, 1 when it has none. */
function orientation(exif: Buffer) {
  if (exif.toString("latin1", 0, 6) !== "Exif\0\0") return 1;
  const tiff = exif.subarray(6);
  const little = tiff.toString("latin1", 0, 2) === "II";
  const u16 = (at: number) =>
    little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at);
  const u32 = (at: number) =>
    little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at);
  const directory = u32(4);
  for (let entry = 0; entry < u16(directory); entry++) {
    const at = directory + 2 + entry * 12;
    if (u16(at) === 0x0112) return u16(at + 8);
  }
  return 1;
}

/**
 * A baseline or progressive JPEG's size, if the browser draws it as decoded: grey or YCbCr, no
 * colour profile, no Adobe colour transform and no rotation.
 */
function jpeg(bytes: Buffer): Still | string {
  for (let at = 2; at + 4 <= bytes.length;) {
    if (bytes[at] !== 0xff) return "its markers are unreadable";
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at++;
      continue;
    }
    const length = bytes.readUInt16BE(at + 2);
    const segment = bytes.subarray(at + 4, at + 2 + length);
    if (marker === 0xe1 && orientation(segment) !== 1)
      return "it is rotated by EXIF";
    if (
      marker === 0xe2 &&
      segment.toString("latin1", 0, 12) === "ICC_PROFILE\0"
    )
      return "it has a colour profile";
    if (marker === 0xee) return "it has an Adobe colour transform";
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    ) {
      if (marker > 0xc2) return "it is not a baseline or progressive JPEG";
      const components = segment[5]!;
      if (components !== 1 && components !== 3)
        return `it has ${components} colour components`;
      return {
        height: segment.readUInt16BE(1),
        width: segment.readUInt16BE(3),
        translucent: false,
      };
    }
    if (marker === 0xda) break;
    at += 2 + length;
  }
  return "it has no frame header";
}

async function readStill(path: string): Promise<Still | string> {
  const bytes = await readFile(path);
  if (bytes.subarray(0, 8).equals(Buffer.from("\x89PNG\r\n\x1a\n", "latin1")))
    return png(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpeg(bytes);
  return "it is not a PNG or JPEG";
}

/**
 * Reads each still the plan draws and gives it its size. A still FFmpeg cannot draw as the browser
 * does, or that would show what lies beneath it when nothing known lies there, goes to the browser,
 * and the server log says why.
 */
export async function placeStills(
  plan: DirectPlan,
  projectDir: string,
): Promise<DirectPlan | { reason: string }> {
  const stills = new Map<string, Still | string>();
  const segments: DirectPlan["segments"] = [];
  const frame = { width: plan.width, height: plan.height };
  for (const segment of plan.segments) {
    let refusal: string | undefined;
    let placed = segment;
    if (segment.kind === "source" && segment.still && segment.placement) {
      let still = stills.get(segment.src);
      if (still === undefined) {
        // The browser asks the capture server for the decoded path, which this same boundary checks.
        still = await projectPath(
          { path: projectDir },
          decodeURIComponent(segment.src),
        )
          .then(readStill)
          .catch(() => "it is not a readable file in the project");
        stills.set(segment.src, still);
      }
      const { placement } = segment;
      if (typeof still === "string") refusal = `${segment.src}: ${still}`;
      else {
        const content = contentRect(segment.still.fit, still, frame);
        const shown = visibleRect(content, placement.crop, frame);
        // Cropping the picture to what shows must land on its own pixels.
        const exact =
          shown &&
          [
            ((shown.left - content.left) * still.width) /
              (content.right - content.left),
            ((shown.top - content.top) * still.height) /
              (content.bottom - content.top),
            ((shown.right - content.left) * still.width) /
              (content.right - content.left),
            ((shown.bottom - content.top) * still.height) /
              (content.bottom - content.top),
          ].every((edge) => Math.abs(edge - Math.round(edge)) < 1e-6);
        if (!shown) refusal = `${segment.src} is cropped away`;
        else if (!exact)
          refusal = `${segment.src} is cropped between its pixels`;
        else if (
          !placement.beneath &&
          (still.translucent || !coversFrame(placement, shown, frame))
        )
          refusal = `${segment.src} shows what lies beneath it`;
        else
          placed = {
            ...segment,
            still: {
              ...segment.still,
              width: still.width,
              height: still.height,
            },
          };
      }
    }
    if (refusal)
      console.info(
        `Capturing frames ${segment.start} to ${segment.end}: ${refusal}.`,
      );
    const drawn = refusal
      ? { kind: "capture" as const, start: segment.start, end: segment.end }
      : placed;
    const previous = segments.at(-1);
    if (drawn.kind === "capture" && previous?.kind === "capture")
      previous.end = drawn.end;
    else segments.push({ ...drawn });
  }
  if (!segments.some((segment) => segment.kind === "source"))
    return { reason: "no frame shows a clip FFmpeg can draw" };
  return { ...plan, segments };
}
