import { pathToFileURL } from "node:url";

/** A time in seconds as an exact fraction, so NTSC frames (1001/30000 s) never drift. */
export interface Rational {
  num: number;
  den: number;
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : Math.abs(a));

export function rational(num: number, den = 1): Rational {
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || den <= 0)
    throw new RangeError(`${num}/${den} is not an exact time.`);
  const divisor = gcd(num, den) || 1;
  return { num: num / divisor, den: den / divisor };
}

export const add = (a: Rational, b: Rational) =>
  rational(a.num * b.den + b.num * a.den, a.den * b.den);

export const times = (a: Rational, factor: number) =>
  rational(a.num * factor, a.den);

/** A frame rate as `num/den` frames per second; its frame lasts `den/num` seconds. */
export interface Rate {
  num: number;
  den: number;
}

/** `frames` frames at `rate`, as seconds. */
export const framesAt = (frames: number, rate: Rate) =>
  rational(frames * rate.den, rate.num);

/** FCPXML's time attribute: seconds as a reduced fraction with an `s`. */
export const fcpTime = ({ num, den }: Rational) =>
  num === 0 ? "0s" : den === 1 ? `${num}s` : `${num}/${den}s`;

/**
 * The frame a source timecode names, counting from 00:00:00:00. Drop-frame timecode (`;`, `.` or
 * `,` before the frames) skips two labels a minute at 29.97 and four at 59.94, except every tenth.
 */
export function timecodeFrames(timecode: string, rate: Rate): number | null {
  const match = /^(\d{1,2}):(\d{2}):(\d{2})([:;.,])(\d{2,3})$/.exec(
    timecode.trim(),
  );
  if (!match) return null;
  const [hours, minutes, seconds, frames] = [
    match[1],
    match[2],
    match[3],
    match[5],
  ].map(Number) as [number, number, number, number];
  const nominal = Math.round(rate.num / rate.den);
  if (minutes > 59 || seconds > 59 || frames >= nominal) return null;
  const counted = ((hours * 60 + minutes) * 60 + seconds) * nominal + frames;
  const ntsc = rate.den === 1001 && nominal % 30 === 0;
  if (match[4] === ":" || !ntsc) return counted;
  const dropped = nominal / 15;
  const total = hours * 60 + minutes;
  return counted - dropped * (total - Math.floor(total / 10));
}

/** Text safe inside an XML attribute: markup escaped and characters XML 1.0 forbids removed. */
export const escapeXml = (text: string) =>
  text
    .replace(
      // eslint-disable-next-line no-control-regex
      /[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
      "",
    )
    .replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&apos;",
        })[character]!,
    );

/** A media file's URL, every reserved character percent-encoded. */
export const fileUrl = (path: string) => pathToFileURL(path).href;

type Attribute = string | number | Rational | undefined;
export interface Element {
  name: string;
  attributes: Record<string, Attribute>;
  children: Element[];
}

export const element = (
  name: string,
  attributes: Record<string, Attribute> = {},
  children: Element[] = [],
): Element => ({ name, attributes, children });

const attributeText = (value: Exclude<Attribute, undefined>) =>
  typeof value === "object"
    ? fcpTime(value)
    : typeof value === "number"
      ? String(Number(value.toFixed(6)) + 0)
      : value;

function serialize(node: Element, depth: number): string {
  const indent = "  ".repeat(depth);
  const attributes = Object.entries(node.attributes)
    .filter(
      (entry): entry is [string, Exclude<Attribute, undefined>] =>
        entry[1] !== undefined,
    )
    .map(([key, value]) => ` ${key}="${escapeXml(attributeText(value))}"`)
    .join("");
  if (!node.children.length) return `${indent}<${node.name}${attributes}/>`;
  return [
    `${indent}<${node.name}${attributes}>`,
    ...node.children.map((child) => serialize(child, depth + 1)),
    `${indent}</${node.name}>`,
  ].join("\n");
}

/** The document Resolve imports: FCPXML 1.11, which Resolve 19.1 and later read. */
export const fcpxmlDocument = (root: Element) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n${serialize(root, 0)}\n`;
