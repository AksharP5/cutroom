import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, posix, relative } from "node:path";
import { scanHtmlOpeningTags } from "@hyperframes/parsers";
import { findFfBinary } from "@hyperframes/parsers/ff-binaries";
import { z } from "zod";
import { localMediaPath } from "../../shared/media.ts";
import { MATTES_FOLDER, clipMatte } from "../../shared/matte.ts";
import type { MatteEntry, MatteStatus } from "../../shared/matte.ts";
import {
  BACKGROUND_ATTRIBUTE,
  readBackground,
} from "../../shared/timeline/background.ts";
import type { Background } from "../../shared/timeline/background.ts";
import { localMediaInputOptions } from "../media/input.ts";
import type { MatteService } from "./service.ts";

/** Where an export's cutouts are written: inside the project, so the render can read them, hidden. */
const EXPORT_FOLDER = `${MATTES_FOLDER}/.export`;

interface MattedVideo {
  src: string;
  /** The `src` and `data-media-start` attribute spans to rewrite. */
  srcSpan: { start: number; end: number; quote: string };
  mediaStartSpan: { start: number; end: number; quote: string } | null;
  mediaStart: number;
  /** Source seconds the clip plays. */
  played: number;
  background: Background;
}

/** Video elements with their background removed, and the source seconds each plays. */
export function mattedVideos(html: string): MattedVideo[] {
  return scanHtmlOpeningTags(html).flatMap((tag) => {
    if (tag.name !== "video") return [];
    const value = (name: string) => {
      const found = tag.attributes.find((entry) => entry.name === name);
      return found?.kind === "value" ? found : undefined;
    };
    const marked = tag.attributes.find(
      (entry) => entry.name === BACKGROUND_ATTRIBUTE,
    );
    const src = value("src");
    const duration = Number(value("data-duration")?.value);
    const rate = Number(value("data-playback-rate")?.value ?? 1);
    // A hidden clip, such as one outside a layer being rendered, needs no cutout.
    const hidden = tag.attributes.some((entry) => entry.name === "data-hidden");
    if (!marked || hidden || !src || !(duration > 0)) return [];
    if (!(rate > 0))
      throw new Error(
        "A clip with its background removed and a speed ramp cannot be exported yet. Set a constant speed, or keep its background.",
      );
    const mediaStart = value("data-media-start");
    return [
      {
        src: src.value,
        srcSpan: { start: src.start, end: src.end, quote: src.quote },
        mediaStartSpan: mediaStart
          ? {
              start: mediaStart.start,
              end: mediaStart.end,
              quote: mediaStart.quote,
            }
          : null,
        mediaStart: Number(mediaStart?.value ?? 0) || 0,
        played: duration * rate,
        background: readBackground(
          marked.kind === "value" ? marked.value : "",
        )!,
      },
    ];
  });
}

const SizeSchema = z.object({
  streams: z.array(
    z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      color_space: z.string().optional(),
      color_primaries: z.string().optional(),
      color_transfer: z.string().optional(),
      side_data_list: z
        .array(z.object({ rotation: z.number().optional() }).loose())
        .optional(),
    }),
  ),
});

/** The source's picture as FFmpeg decodes it, turned upright, and its colour tags. */
async function picture(ffprobe: string, path: string) {
  const child = Bun.spawn(
    [
      ffprobe,
      ...["-v", "error", ...localMediaInputOptions],
      ...["-select_streams", "v:0", "-show_streams", "-of", "json", path],
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [text, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  const stream =
    code === 0 ? SizeSchema.parse(JSON.parse(text)).streams[0] : undefined;
  if (!stream) throw new Error(`FFmpeg could not read ${path}.`);
  const turn =
    Math.abs(
      stream.side_data_list?.find((entry) => entry.rotation !== undefined)
        ?.rotation ?? 0,
    ) % 180;
  const known = (tag: string | undefined) =>
    tag && tag !== "unknown" && tag !== "reserved" ? tag : "bt709";
  return {
    width: turn === 90 ? stream.height : stream.width,
    height: turn === 90 ? stream.width : stream.height,
    colour: [
      ...["-colorspace", known(stream.color_space)],
      ...["-color_primaries", known(stream.color_primaries)],
      ...["-color_trc", known(stream.color_transfer)],
    ],
  };
}

/**
 * The refine FFmpeg runs on a matte, as the viewer's GPU passes do: scaled to the picture
 * bilinearly, its limited range expanded, eroded `shrink` times with a 3x3 minimum, then a box
 * blur `soften` pixels each side.
 */
export function refineFilter(
  { shrink, soften }: Background,
  width: number,
  height: number,
) {
  return [
    `scale=${width}:${height}:flags=bilinear`,
    "lut=y='clip((val-16)*255/219,0,255)'",
    ...Array.from({ length: shrink }, () => "erosion"),
    ...(soften ? [`boxblur=luma_radius=${soften}:luma_power=1`] : []),
  ].join(",");
}

/**
 * Writes the cutout of source frames `[first, end)`: the source's own colour with the refined
 * matte as alpha, in ProRes 4444, frame k of the source at `(k - first) / rate`.
 */
async function renderCutout(options: {
  ffmpeg: string;
  ffprobe: string;
  source: string;
  output: string;
  projectDir: string;
  mattes: MatteEntry[];
  first: number;
  end: number;
  rate: number;
  variable: boolean;
  background: Background;
  signal: AbortSignal;
}) {
  const { ffmpeg, first, end, rate } = options;
  const frames = end - first;
  const { width, height, colour } = await picture(
    options.ffprobe,
    options.source,
  );
  // Mattes are stored at the model's own size, the same for every file of a source.
  const stored = options.mattes.find((entry) => entry.subject);
  if (!stored) throw new Error("The clip has no matte to cut out.");
  const mask = await picture(
    options.ffprobe,
    join(options.projectDir, stored.file),
  );
  const child = Bun.spawn(
    [
      ...[ffmpeg, "-v", "error", "-nostdin", "-y", ...localMediaInputOptions],
      ...[
        "-ss",
        Math.max(0, (first - 0.5) / rate).toFixed(6),
        "-i",
        options.source,
      ],
      ...[
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray",
        "-s",
        `${mask.width}x${mask.height}`,
      ],
      ...["-r", String(rate), "-i", "pipe:0"],
      "-filter_complex",
      [
        `[0:v]${options.variable ? `fps=${rate},` : ""}setpts=N/(${rate})/TB[c]`,
        `[1:v]setpts=N/(${rate})/TB,${refineFilter(options.background, width, height)}[m]`,
        "[c][m]alphamerge,format=yuva444p10le[o]",
      ].join(";"),
      ...["-map", "[o]", "-frames:v", String(frames), "-r", String(rate)],
      ...["-c:v", "prores_ks", "-profile:v", "4444", "-vendor", "apl0"],
      ...["-pix_fmt", "yuva444p10le", ...colour, "-an", options.output],
    ],
    { stdin: "pipe", stderr: "pipe", signal: options.signal },
  );
  const errors = new Response(child.stderr).text();
  // The matte frames, in order, from each file that holds some of the range. A range the model
  // found empty is fully transparent.
  for (const entry of options.mattes) {
    const from = Math.max(first, entry.first);
    const to = Math.min(end, entry.first + entry.frames);
    if (to <= from) continue;
    if (!entry.subject) {
      const empty = new Uint8Array(mask.width * mask.height).fill(16);
      for (let frame = from; frame < to; frame++) child.stdin.write(empty);
      continue;
    }
    const decode = Bun.spawn(
      [
        ...[ffmpeg, "-v", "error", "-nostdin"],
        ...[
          "-ss",
          Math.max(0, (from - entry.first - 0.5) / entry.rate).toFixed(6),
        ],
        ...["-i", join(options.projectDir, entry.file)],
        ...["-frames:v", String(to - from), "-fps_mode", "passthrough"],
        ...["-vf", "extractplanes=y", "-f", "rawvideo", "pipe:1"],
      ],
      { stdout: "pipe", stderr: "ignore", signal: options.signal },
    );
    for await (const chunk of decode.stdout) child.stdin.write(chunk);
    if ((await decode.exited) !== 0)
      throw new Error(`FFmpeg could not read the matte ${entry.file}.`);
  }
  await child.stdin.end();
  if ((await child.exited) !== 0)
    throw new Error(
      `The cutout could not be made. ${(await errors).slice(-1500)}`,
    );
}

/**
 * Before an export: waits for the mattes its Remove clips need, renders each clip's cutout into a
 * hidden folder of the project, and points the clip at it, so frame capture composites the cutout
 * over the tracks below as it would any transparent video. The marker stays on the element, which
 * keeps the clip out of the direct FFmpeg path. A clip the model found no subject in exports its
 * original picture, as the viewer shows it.
 */
export async function prepareMatteExport(options: {
  project: { id: string; path: string };
  /** The composition, relative to the project. */
  composition: string;
  html: string;
  mattes: MatteService;
  signal: AbortSignal;
  onWait: (progress: number) => void;
}): Promise<{ html: string; cleanup: () => Promise<void> } | null> {
  const videos = mattedVideos(options.html);
  if (!videos.length) return null;
  const ffmpeg = findFfBinary("ffmpeg", { configuredMustExist: true });
  const ffprobe = findFfBinary("ffprobe", { configuredMustExist: true });
  if (!ffmpeg || !ffprobe) throw new Error("FFmpeg is not installed.");
  const needs = videos.map((video) => {
    const src = localMediaPath(options.composition, video.src);
    if (!src)
      throw new Error(
        `${video.src} is not in the project, so its background cannot be removed.`,
      );
    return {
      video,
      src,
      from: video.mediaStart,
      to: video.mediaStart + video.played,
    };
  });
  // Ask for every range, then wait until each is made.
  let status: MatteStatus | undefined;
  for (const need of needs)
    status = await options.mattes.request(options.project, {
      src: need.src,
      from: need.from,
      to: need.to,
    });
  for (;;) {
    status = await options.mattes.status(options.project);
    if (
      status.model.status === "missing" ||
      status.model.status === "no-runtime"
    )
      throw new Error(
        "Remove background needs its model. Download it from a clip's Background row, then export again.",
      );
    const states = needs.map((need) =>
      clipMatte(status!, need.src, need.from, need.to),
    );
    const failed = states.find((state) => state.state === "failed");
    if (failed && failed.state === "failed")
      throw new Error(
        `Background removal stopped, so the export cannot show the cutout. ${failed.error}`,
      );
    if (
      states.every(
        (state) => state.state === "ready" || state.state === "no-subject",
      )
    )
      break;
    options.onWait(
      states.reduce(
        (total, state) =>
          total +
          (state.state === "running"
            ? state.progress
            : state.state === "ready"
              ? 1
              : 0),
        0,
      ) / states.length,
    );
    await Bun.sleep(250);
    if (options.signal.aborted) throw new Error("The export was cancelled.");
  }
  const folder = `${EXPORT_FOLDER}/${randomUUID()}`;
  const absolute = join(options.project.path, folder);
  await mkdir(absolute, { recursive: true });
  const cleanup = () => rm(absolute, { recursive: true, force: true });
  try {
    const edits: { start: number; end: number; text: string }[] = [];
    for (const [index, { video, src, from, to }] of needs.entries()) {
      const entries = status.mattes
        .filter((entry) => entry.src === src)
        .sort((a, b) => a.first - b.first);
      const grid = entries[0];
      const state = clipMatte(status, src, from, to);
      if (state.state !== "ready" || !grid) continue;
      const first = Math.max(
        0,
        Math.floor((from - grid.start) * grid.rate + 1e-6),
      );
      const end = Math.max(
        first + 1,
        Math.ceil((to - grid.start) * grid.rate - 1e-6),
      );
      const name = `${index}.mov`;
      await renderCutout({
        ffmpeg,
        ffprobe,
        source: join(options.project.path, src),
        output: join(absolute, name),
        projectDir: options.project.path,
        mattes: entries,
        first,
        end,
        rate: grid.rate,
        variable: grid.variable,
        background: video.background,
        signal: options.signal,
      });
      const cutout = posix.join(
        relative(
          dirname(join(options.project.path, options.composition)),
          absolute,
        )
          .split("\\")
          .join("/"),
        name,
      );
      const { quote } = video.srcSpan;
      edits.push({
        ...video.srcSpan,
        text: `src=${quote}${cutout}${quote}`,
      });
      // Cutout time 0 is source frame `first`.
      const mediaStart = video.mediaStart - (grid.start + first / grid.rate);
      const value = `data-media-start=${video.mediaStartSpan?.quote || '"'}${mediaStart.toFixed(6)}${video.mediaStartSpan?.quote || '"'}`;
      if (video.mediaStartSpan)
        edits.push({ ...video.mediaStartSpan, text: value });
      else
        edits.push({
          start: video.srcSpan.end,
          end: video.srcSpan.end,
          text: ` ${value}`,
        });
    }
    let html = "";
    let cursor = 0;
    for (const { start, end, text } of edits.sort(
      (a, b) => a.start - b.start,
    )) {
      html += options.html.slice(cursor, start) + text;
      cursor = end;
    }
    return { html: html + options.html.slice(cursor), cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
