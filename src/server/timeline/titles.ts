import { toFrames, toSeconds } from "../../shared/timeline/apply";
import { TitleSchema } from "../../shared/timeline/schema";
import type { Fps, Title } from "../../shared/timeline/schema";

/** Marks an element as a Cutroom title; the value is the attribute format's version. */
export const TITLE_ATTRIBUTE = "data-cutroom-title";
const TITLE_VERSION = "1";

/**
 * The one stylesheet that turns a title's attributes into its layout, look and motion. It reads
 * the clip's own `data-duration`, so a trim keeps the exit on the last frame without a rewrite,
 * and it holds no script: the runtime's CSS adapter seeks these animations in clip-local time in
 * preview and render alike. Typed `attr()` needs Chromium 133 or newer.
 *
 * Motion is on `transform`, `opacity` and `clip-path`; Position offsets use `translate`, so the
 * two compose. Keyframe names and geometry are part of saved projects: bump the version to change.
 */
const TITLE_RULES = [
  "@keyframes cutroom-title-fade-in{from{opacity:0}}",
  "@keyframes cutroom-title-fade-out{to{opacity:0}}",
  "@keyframes cutroom-title-slide-in{from{opacity:0;transform:translateY(var(--cutroom-title-travel))}to{transform:none}}",
  "@keyframes cutroom-title-slide-out{from{transform:none}to{opacity:0;transform:translateY(var(--cutroom-title-travel))}}",
  "@keyframes cutroom-title-scale-in{from{opacity:0;transform:scale(.9)}to{transform:none}}",
  "@keyframes cutroom-title-scale-out{from{transform:none}to{opacity:0;transform:scale(.9)}}",
  "@keyframes cutroom-title-wipe-in{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0)}}",
  "@keyframes cutroom-title-wipe-out{from{clip-path:inset(0)}to{clip-path:inset(0 0 0 100%)}}",
  `[${TITLE_ATTRIBUTE}]{` +
    "position:absolute;margin:0;width:fit-content;max-width:88%;line-height:1.15;" +
    "font-size:attr(data-title-size type(<length>),64px);" +
    "font-weight:attr(data-title-weight type(<number>),600);" +
    "color:attr(data-title-color type(<color>),#fff);" +
    "--cutroom-title-travel:.6em;" +
    "--cutroom-title-length:attr(data-duration type(<number>),0);" +
    "--cutroom-title-in:0;--cutroom-title-out:0;" +
    "--cutroom-title-in-name:none;--cutroom-title-out-name:none;" +
    // An entrance and exit longer than the clip shrink together, as audio fades do.
    "--cutroom-title-fit:min(1,var(--cutroom-title-length)/max(var(--cutroom-title-in) + var(--cutroom-title-out),.001));" +
    "animation-name:var(--cutroom-title-in-name),var(--cutroom-title-out-name);" +
    "animation-duration:calc(var(--cutroom-title-in)*var(--cutroom-title-fit)*1s),calc(var(--cutroom-title-out)*var(--cutroom-title-fit)*1s);" +
    "animation-delay:0s,calc((var(--cutroom-title-length) - var(--cutroom-title-out)*var(--cutroom-title-fit))*1s);" +
    "animation-fill-mode:backwards,forwards;" +
    "animation-timing-function:cubic-bezier(.16,1,.3,1),cubic-bezier(.7,0,.84,0)}",
  "[data-title-plate]{background:attr(data-title-plate type(<color>));padding:.35em .6em;border-radius:.1em}",
  '[data-title-align="center"]{text-align:center}',
  '[data-title-align="right"]{text-align:right}',
  '[data-title-position="lower-left"]{left:6%;bottom:10%}',
  '[data-title-position="lower-center"]{left:0;right:0;bottom:10%;margin-inline:auto}',
  '[data-title-position="lower-right"]{right:6%;bottom:10%}',
  '[data-title-position="center"]{inset:0;margin:auto;height:fit-content}',
  '[data-title-position="top"]{left:0;right:0;top:8%;margin-inline:auto;--cutroom-title-travel:-.6em}',
  ...(["fade", "slide", "scale", "wipe"] as const).flatMap((preset) => [
    `[data-title-in="${preset}"]{--cutroom-title-in:attr(data-title-in-duration type(<number>),0);--cutroom-title-in-name:cutroom-title-${preset}-in}`,
    `[data-title-out="${preset}"]{--cutroom-title-out:attr(data-title-out-duration type(<number>),0);--cutroom-title-out-name:cutroom-title-${preset}-out}`,
  ]),
];

/**
 * The stylesheet block for a composition whose titles use `fonts`. Each family gets a literal
 * rule, because HyperFrames resolves the fonts a render needs from `font-family` values it can
 * read. A family passed the title schema, so it holds no quote, backslash or markup.
 */
export const titleStyle = (fonts: Iterable<string>) =>
  `<style data-cutroom-titles="${TITLE_VERSION}">\n${[
    ...TITLE_RULES,
    ...[...new Set(fonts)]
      .sort()
      .map(
        (font) =>
          `[data-title-font="${font}"]{font-family:"${font}",sans-serif}`,
      ),
  ].join("\n")}\n</style>`;

type Attributes = Readonly<Record<string, string | undefined>>;

const seconds = (value: string | undefined, fps: Fps) =>
  value !== undefined && /^\d+(?:\.\d+)?$/.test(value)
    ? toFrames(Number(value), fps)
    : Number.NaN;

const FIELD_ATTRIBUTES: Record<string, string> = {
  position: "data-title-position",
  font: "data-title-font",
  size: "data-title-size",
  weight: "data-title-weight",
  color: "data-title-color",
  align: "data-title-align",
  plate: "data-title-plate",
  "in.preset": "data-title-in",
  "in.frames": "data-title-in-duration",
  "out.preset": "data-title-out",
  "out.frames": "data-title-out-duration",
};

/**
 * A title's settings from its element, or why they cannot be read. An element is a title only when
 * every attribute passes the same schema commands do, so a hand-edited value never reaches the
 * inspector or a later write.
 */
export function readTitle(
  attrs: Attributes,
  fps: Fps,
): { title: Title } | { reason: string } | null {
  if (attrs[TITLE_ATTRIBUTE] === undefined) return null;
  const size = attrs["data-title-size"];
  const weight = attrs["data-title-weight"];
  const parsed = TitleSchema.safeParse({
    position: attrs["data-title-position"],
    font: attrs["data-title-font"] ?? null,
    size: size && /^\d+px$/.test(size) ? Number.parseInt(size, 10) : size,
    weight: weight && /^\d+$/.test(weight) ? Number(weight) : weight,
    color: attrs["data-title-color"],
    align: attrs["data-title-align"],
    plate: attrs["data-title-plate"] ?? null,
    in: {
      preset: attrs["data-title-in"],
      frames: seconds(attrs["data-title-in-duration"], fps),
    },
    out: {
      preset: attrs["data-title-out"],
      frames: seconds(attrs["data-title-out-duration"], fps),
    },
  });
  if (parsed.success) return { title: parsed.data };
  const attribute =
    FIELD_ATTRIBUTES[parsed.error.issues[0]!.path.join(".")] ?? TITLE_ATTRIBUTE;
  return {
    reason: `This title's ${attribute} is ${attrs[attribute] === undefined ? "missing" : "not a value Cutroom writes"}. Edit it in the source.`,
  };
}

/** Every attribute of a title, in the order a new title is written. Null removes one. */
export function titleAttributes(
  title: Title,
  fps: Fps,
): [name: string, value: string | null][] {
  return [
    [TITLE_ATTRIBUTE, TITLE_VERSION],
    ["data-title-position", title.position],
    ["data-title-font", title.font],
    ["data-title-size", `${title.size}px`],
    ["data-title-weight", String(title.weight)],
    ["data-title-color", title.color],
    ["data-title-align", title.align],
    ["data-title-plate", title.plate],
    ["data-title-in", title.in.preset],
    ["data-title-in-duration", String(toSeconds(title.in.frames, fps))],
    ["data-title-out", title.out.preset],
    ["data-title-out-duration", String(toSeconds(title.out.frames, fps))],
  ];
}

/** Font families a document's own `@font-face` rules declare. */
export function declaredFonts(html: string): string[] {
  const families = new Set<string>();
  for (const [, style] of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi))
    for (const [, rule] of style!.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
      const family = /font-family\s*:\s*(?:"([^"]+)"|'([^']+)'|([^;]+))/i.exec(
        rule!,
      );
      const name = (family?.[1] ?? family?.[2] ?? family?.[3])?.trim();
      if (name) families.add(name);
    }
  return [...families];
}
