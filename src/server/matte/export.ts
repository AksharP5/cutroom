import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, posix, relative } from "node:path";
import { scanHtmlOpeningTags } from "@hyperframes/parsers";
import { parseRateLane } from "@hyperframes/core/speed-ramp";
import { findFfBinary } from "@hyperframes/parsers/ff-binaries";
import { z } from "zod";
import { localMediaPath } from "../../shared/media.ts";
import { chromeColourGuess } from "../../shared/videoColour.ts";
import { MATTES_FOLDER, clipMatte } from "../../shared/matte.ts";
import type { MatteEntry, MatteStatus } from "../../shared/matte.ts";
import {
  BACKGROUND_ATTRIBUTE,
  readBackground,
} from "../../shared/timeline/background.ts";
import type { Background } from "../../shared/timeline/background.ts";
import { secondsOf } from "../../shared/timeline/piece.ts";
import {
  compositionScope,
  compositionWindows,
} from "../timeline/composition.ts";
import { localMediaInputOptions } from "../media/input.ts";
import { projectPath } from "../projects/path.ts";
import type { MatteService } from "./service.ts";

/** Where an export's cutouts are written: inside the project, so the render can read them, hidden. */
export const EXPORT_FOLDER = `${MATTES_FOLDER}/.export`;

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

/**
 * Video elements with their background removed, and the source seconds each plays. With a range
 * in composition seconds, only those that play in it.
 */
export function mattedVideos(
  html: string,
  range?: { start: number; end: number },
  composition = "index.html",
): MattedVideo[] {
  let windows: ReturnType<typeof compositionWindows> | undefined;
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
    if (range) {
      windows ??= compositionWindows(html, compositionScope(composition));
      const window = windows.get(tag.start);
      if (
        window &&
        (secondsOf(window.start) >= range.end ||
          (window.end && secondsOf(window.end) <= range.start))
      )
        return [];
    }
    const automation = value("data-automation")?.value ?? null;
    if (!(rate > 0) || parseRateLane(automation) !== null)
      throw new Error(
        `${value("id")?.value ?? src.value} has a speed ramp and its background removed, which cannot be exported yet. Set a constant speed, or keep its background.`,
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
      codec_name: z.string(),
      color_space: z.string().optional(),
      color_primaries: z.string().optional(),
      color_transfer: z.string().optional(),
      color_range: z.string().optional(),
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
  const guess = chromeColourGuess(stream.height, stream.codec_name);
  const known = (tag: string | undefined, fallback: string) =>
    tag && /^[a-z0-9-]+$/.test(tag) && tag !== "unknown" && tag !== "reserved"
      ? tag
      : fallback;
  const matrix = known(stream.color_space, guess);
  const fallback = matrix === "bt709" ? "bt709" : guess;
  const primaries = known(stream.color_primaries, fallback);
  const transfer = known(stream.color_transfer, fallback);
  const range = stream.color_range === "pc" ? "pc" : "tv";
  return {
    width: turn === 90 ? stream.height : stream.width,
    height: turn === 90 ? stream.width : stream.height,
    // alphamerge can negotiate a pixel format conversion. Supply the source's
    // colour before that happens, and convert full-range samples for ProRes.
    colourFilter: [
      `setparams=colorspace=${matrix}:color_primaries=${primaries}:color_trc=${transfer}:range=${range}`,
      ...(range === "pc" ? ["scale=in_range=pc:out_range=tv"] : []),
    ].join(","),
    colour: [
      ...["-colorspace", matrix],
      ...["-color_primaries", primaries],
      ...["-color_trc", transfer],
      ...["-color_range", "tv"],
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
  project: { path: string };
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
  const { width, height, colour, colourFilter } = await picture(
    options.ffprobe,
    options.source,
  );
  // Mattes are stored at the model's own size, the same for every file of a source.
  const stored = options.mattes.find((entry) => entry.subject);
  if (!stored) throw new Error("The clip has no matte to cut out.");
  const mask = await picture(
    options.ffprobe,
    await projectPath(options.project, stored.file),
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
        `[0:v]${options.variable ? `fps=${rate},` : ""}setpts=N/(${rate})/TB,${colourFilter}[c]`,
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
      for (let frame = from; frame < to; frame++) {
        child.stdin.write(empty);
        await child.stdin.flush();
      }
      continue;
    }
    const decode = Bun.spawn(
      [
        ...[ffmpeg, "-v", "error", "-nostdin", ...localMediaInputOptions],
        ...[
          "-ss",
          Math.max(0, (from - entry.first - 0.5) / entry.rate).toFixed(6),
        ],
        ...["-f", "mov", "-i", await projectPath(options.project, entry.file)],
        ...["-frames:v", String(to - from), "-fps_mode", "passthrough"],
        ...["-vf", "extractplanes=y", "-f", "rawvideo", "pipe:1"],
      ],
      { stdout: "pipe", stderr: "ignore", signal: options.signal },
    );
    try {
      // Waits for the encoder to take each chunk, so a long range never piles up in memory.
      for await (const chunk of decode.stdout) {
        child.stdin.write(chunk);
        await child.stdin.flush();
      }
      if ((await decode.exited) !== 0)
        throw new Error(`FFmpeg could not read the matte ${entry.file}.`);
    } catch (error) {
      decode.kill("SIGKILL");
      child.kill("SIGKILL");
      throw error;
    }
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
  /** The exported part of the composition, in seconds; a cutout outside it is not made. */
  range?: { start: number; end: number };
  mattes: MatteService;
  signal: AbortSignal;
  onWait: (progress: number) => void;
}): Promise<{ html: string; cleanup: () => Promise<void> } | null> {
  const videos = mattedVideos(options.html, options.range, options.composition);
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
  // Ask for what is missing on every pass, so a range that lost its job is asked again, and stop
  // with a reason when nothing will make it. A clip whose removal failed exports as shot, as the
  // viewer shows it.
  let status: MatteStatus;
  for (;;) {
    if (options.signal.aborted) throw new Error("The export was cancelled.");
    status = await options.mattes.status(options.project);
    const model = status.model;
    if (model.status === "missing" || model.status === "no-runtime")
      throw new Error(
        "Remove background needs its model. Download it from a clip's Background row, then export again.",
      );
    if (model.status === "failed")
      throw new Error(
        `The background removal model could not be downloaded, so the export cannot show the cutout. ${model.error}`,
      );
    const stopped = needs.find((need) =>
      status.jobs.some(
        (job) =>
          job.status === "stopped" &&
          job.src === need.src &&
          job.first < Math.ceil((need.to - job.start) * job.rate) &&
          job.first + job.frames >
            Math.floor((need.from - job.start) * job.rate),
      ),
    );
    if (stopped)
      throw new Error(
        `Background removal for ${stopped.src} was stopped, so the export cannot show its cutout. Turn Remove on again, or keep its background.`,
      );
    for (const need of needs)
      status = await options.mattes
        .request(options.project, {
          src: need.src,
          from: need.from,
          to: need.to,
          composition: options.composition,
        })
        .catch((error: unknown) => {
          throw new Error(
            `The background of ${need.src} cannot be removed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    const states = needs.map((need) =>
      clipMatte(status, need.src, need.from, need.to),
    );
    const unqueued = needs.find(
      (_need, index) =>
        states[index]!.state === "waiting" && !("job" in states[index]!),
    );
    if (unqueued)
      throw new Error(
        `Nothing is making the matte of ${unqueued.src}, so the export cannot show its cutout.`,
      );
    if (
      states.every((state) =>
        ["ready", "no-subject", "failed"].includes(state.state),
      )
    )
      break;
    options.onWait(
      states.reduce(
        (total, state) =>
          total +
          (state.state === "running"
            ? state.progress
            : state.state === "waiting" || state.state === "needs-model"
              ? 0
              : 1),
        0,
      ) / states.length,
    );
    await Bun.sleep(250);
  }
  const parent = await projectPath(options.project, EXPORT_FOLDER, true);
  await mkdir(parent, { recursive: true });
  // A folder only this export made: nothing already there, a link included, is written through.
  const absolute = join(parent, randomUUID());
  await mkdir(absolute);
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
        project: options.project,
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
