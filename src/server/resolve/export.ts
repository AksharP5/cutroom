import { constants } from "node:fs";
import {
  copyFile,
  mkdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import { findFfBinary } from "@hyperframes/parsers/ff-binaries";
import { HttpError } from "../../shared/errors";
import { localMediaPath, mediaKind } from "../../shared/media";
import type { ResolveExport } from "../../shared/export";
import type { Project } from "../../shared/project";
import { isAudioKind } from "../../shared/timeline/schema";
import type { Clip, Timeline } from "../../shared/timeline/schema";
import { formatTimecode } from "../../shared/timeline/timecode";
import { localMediaInputOptions } from "../media/input";
import { projectPath, unavailableProjectFile } from "../projects/path";
import { layerTracks } from "./layers";
import type { LayerTrack } from "./layers";
import { label, planResolveTimeline } from "./plan";
import type { ClipMedia } from "./plan";
import { probeMedia } from "./probe";
import type { MediaFacts } from "./probe";

/** A name Cutroom writes inside the export folder: one path segment, no hidden or control characters. */
export const safeName = (name: string, fallback: string) =>
  name
    .replace(/[/\\\x00-\x1f\x7f]/g, "-")
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(0, 120) || fallback;

/** Claims a new folder in `directory`, adding a number when the name is taken. */
async function claimFolder(directory: string, name: string) {
  for (let number = 1; ; number++) {
    const path = join(directory, number === 1 ? name : `${name} ${number}`);
    try {
      await mkdir(path);
      return path;
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ))
        throw error;
    }
  }
}

export interface ResolveSource {
  project: Project;
  /** The composition's path in the project, such as index.html. */
  composition: string;
  /** The name the timeline and its folder take. */
  name: string;
  timeline: Timeline;
  size: { width: number; height: number };
  /** Image variables' current files, by variable id. */
  images: ReadonlyMap<string, string>;
  /** Each graded clip's grade as a .cube LUT, by clip id. */
  grades?: ReadonlyMap<string, string>;
}

/** Each clip's local media: only files inside the project, which the timeline names. */
async function clipMedia(source: ResolveSource) {
  const { project, composition, timeline } = source;
  const probes = new Map<string, Promise<MediaFacts | null>>();
  const offline = new Set<string>();
  /** Clips whose media is missing or outside the project: never rendered, only named. */
  const unreachable = new Set<string>();
  const media = new Map<string, ClipMedia>();
  await Promise.all(
    timeline.clips.map(async (clip) => {
      const image = clip.variableBindings?.image;
      const src = (image && source.images.get(image)) || clip.src;
      if (!src || !["video", "audio", "voiceover", "image"].includes(clip.kind))
        return;
      const relative = localMediaPath(composition, src);
      if (!relative || relative.startsWith("../")) return;
      const path = await projectPath(project, relative).catch(
        (error: unknown) => {
          if (unavailableProjectFile(error)) return null;
          throw error;
        },
      );
      if (!path || !(await stat(path).catch(() => null))?.isFile()) {
        offline.add(relative);
        unreachable.add(clip.id);
        return;
      }
      if (clip.kind === "image") {
        if (
          mediaKind(path)?.kind === "image" &&
          extname(path).toLowerCase() !== ".svg"
        )
          media.set(clip.id, { kind: "still", path });
        return;
      }
      let probe = probes.get(path);
      if (!probe) {
        probe = probeMedia(path);
        probes.set(path, probe);
      }
      const facts = await probe;
      if (facts) media.set(clip.id, { kind: "file", facts });
    }),
  );
  return { media, offline: [...offline].sort(), unreachable };
}

/** Copies each file once into `folder`, keeping its name unless another file took it. */
async function copyMedia(folder: string, media: Map<string, ClipMedia>) {
  await mkdir(folder);
  const copies = new Map<string, Promise<string>>();
  const taken = new Set<string>();
  const copy = (path: string) => {
    let copied = copies.get(path);
    if (copied) return copied;
    const extension = extname(path);
    const stem = safeName(basename(path, extension), "Media");
    let name = `${stem}${extension}`;
    for (let number = 2; taken.has(name); number++)
      name = `${stem} ${number}${extension}`;
    taken.add(name);
    const target = join(folder, name);
    copied = copyFile(
      path,
      target,
      constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
    ).then(() => target);
    copies.set(path, copied);
    return copied;
  };
  await Promise.all(
    [...media].map(async ([id, entry]) => {
      if (entry.kind === "still")
        media.set(id, { kind: "still", path: await copy(entry.path) });
      else
        media.set(id, {
          ...entry,
          facts: { ...entry.facts, path: await copy(entry.facts.path) },
        });
    }),
  );
}

/** Sound Resolve on Linux can't decode: it plays these files silent. */
const SILENT_ON_LINUX = new Set(["aac"]);

/**
 * Decodes each file whose sound Resolve can't play into a WAV in `folder`, aligned so a second
 * into the WAV is a second into the file. The pictures keep linking the original files.
 */
async function decodeSound(
  folder: string,
  media: Map<string, ClipMedia>,
  heard: ReadonlySet<string>,
) {
  const files = new Map<string, MediaFacts>();
  for (const [id, entry] of media)
    if (
      heard.has(id) &&
      entry.kind === "file" &&
      entry.facts.audio &&
      SILENT_ON_LINUX.has(entry.facts.audio.codec)
    )
      files.set(entry.facts.path, entry.facts);
  if (!files.size) return [];
  const ffmpeg = findFfBinary("ffmpeg", { configuredMustExist: true });
  if (!ffmpeg) throw new Error("FFmpeg is needed to read media.");
  await mkdir(folder);
  const taken = new Set<string>();
  const decoded = new Map<string, MediaFacts>();
  for (const [path, facts] of files) {
    // Resolve swaps a WAV named like its video (a.wav, a.mp4) back to the video's silent sound.
    const stem = `${safeName(basename(path, extname(path)), "Media")} sound`;
    let name = `${stem}.wav`;
    for (let number = 2; taken.has(name); number++)
      name = `${stem} ${number}.wav`;
    taken.add(name);
    const target = join(folder, name);
    const child = Bun.spawn(
      [
        ffmpeg,
        ...["-nostdin", "-v", "error", ...localMediaInputOptions, "-i", path],
        ...["-map", "0:a:0", "-af", "aresample=async=1:first_pts=0"],
        ...["-c:a", "pcm_s24le", "-ar", String(facts.audio!.sampleRate)],
        ...["-f", "wav", "-n", target],
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const [error, code] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0)
      throw new Error(
        `The sound of ${basename(path)} could not be decoded: ${error.trim()}`,
      );
    const probed = await probeMedia(target);
    if (probed) decoded.set(path, probed);
  }
  for (const [id, entry] of media)
    if (entry.kind === "file" && decoded.has(entry.facts.path))
      media.set(id, { ...entry, sound: decoded.get(entry.facts.path) });
  return [...decoded.keys()].map((path) => basename(path)).sort();
}

const describeRate = ({ num, den }: { num: number; den: number }) =>
  String(Number((num / den).toFixed(3)));

/**
 * Writes a folder Resolve opens: the timeline as FCPXML, its markers as an EDL, and a summary of
 * what could not be carried. Nothing is written outside the new folder.
 */
export async function exportResolve(
  source: ResolveSource,
  options: {
    directory: string;
    copyMedia: boolean;
    /** Renders one layer as a ProRes 4444 MOV in `directory`, answering its path. */
    render?: (
      layer: LayerTrack,
      output: { directory: string; filename: string },
    ) => Promise<string>;
  },
): Promise<ResolveExport> {
  if (!isAbsolute(options.directory))
    throw new HttpError(400, "Enter an absolute output folder.");
  const directory = await realpath(options.directory).catch(() => {
    throw new HttpError(400, "The output folder does not exist.");
  });
  if (!(await stat(directory)).isDirectory())
    throw new HttpError(400, "The output folder is not a folder.");
  const stem = safeName(source.name, "Cut");
  const found = await clipMedia(source);
  const folder = await claimFolder(directory, `${stem} Resolve`);
  try {
    return await writePackage(source, options, stem, folder, found);
  } catch (error) {
    // The folder is this export's own, so a failure leaves nothing half-written behind.
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
}

/** A clip drawn into a layer render: plain video of that file, every look already in it. */
const rendered = (clip: Clip, mediaStart: number): Clip => ({
  ...clip,
  kind: "video",
  mediaStart,
  playbackRate: 1,
  hasAudio: false,
  link: null,
  volume: null,
  opacity: null,
  x: null,
  y: null,
  scaleX: null,
  scaleY: null,
  rotation: null,
  crop: null,
  keyframes: null,
  region: null,
  adjustment: false,
  style: {},
  fadeIn: 0,
  fadeOut: 0,
  transitionIn: null,
  transitionOut: null,
  automation: null,
  fx: [],
});

async function writePackage(
  source: ResolveSource,
  options: Parameters<typeof exportResolve>[1],
  stem: string,
  folder: string,
  { media, offline, unreachable }: Awaited<ReturnType<typeof clipMedia>>,
): Promise<ResolveExport> {
  const decoded =
    process.platform === "linux"
      ? await decodeSound(
          join(folder, "Sound"),
          media,
          new Set(
            source.timeline.clips
              .filter((clip) => clip.hasAudio && clip.enabled)
              .map((clip) => clip.id),
          ),
        )
      : [];
  if (options.copyMedia) await copyMedia(join(folder, "Media"), media);

  // What Resolve can't open renders with transparency, a MOV per track, each clip its own cut of it.
  const { fps } = source.timeline;
  const videoTracks = [
    ...new Set([
      ...source.timeline.tracks
        .filter((track) => track.kind === "video")
        .map((track) => track.index),
      ...source.timeline.clips
        .filter((clip) => !isAudioKind(clip.kind))
        .map((clip) => clip.track),
    ]),
  ].sort((a, b) => a - b);
  const trackName = (index: number) => `V${videoTracks.indexOf(index) + 1}`;
  const layers = options.render
    ? layerTracks(source.timeline, new Set([...media.keys(), ...unreachable]))
    : [];
  const replaced = new Map<string, Clip>();
  const layerNotes: string[] = [];
  if (layers.length) await mkdir(join(folder, "Layers"));
  for (const layer of layers) {
    const filename = `${trackName(layer.track)}.mov`;
    const path = await options.render!(layer, {
      directory: join(folder, "Layers"),
      filename,
    });
    const facts = await probeMedia(path);
    if (!facts?.video)
      throw new Error(`The ${filename} layer could not be read back.`);
    for (const clip of layer.clips) {
      media.set(clip.id, { kind: "file", facts });
      replaced.set(
        clip.id,
        rendered(clip, ((clip.start - layer.start) * fps.den) / fps.num),
      );
    }
    layerNotes.push(
      layer.flatten
        ? `${trackName(layer.track)}'s blur or highlight is drawn over the tracks beneath it in Layers/${filename}, as they were when exported.`
        : `${trackName(layer.track)}'s titles, scenes and other clips Resolve can't open are rendered with transparency in Layers/${filename}, one clip each.`,
    );
  }
  const timelineIn = replaced.size
    ? {
        ...source.timeline,
        clips: source.timeline.clips.map(
          (clip) => replaced.get(clip.id) ?? clip,
        ),
      }
    : source.timeline;

  const grades = [...(source.grades ?? [])].flatMap(([id, cube]) => {
    const clip = source.timeline.clips.find((entry) => entry.id === id);
    return clip ? [{ clip, cube }] : [];
  });
  const gradeNotes: string[] = [];
  if (grades.length) {
    await mkdir(join(folder, "LUTs"));
    const taken = new Set<string>();
    for (const { clip, cube } of grades) {
      const stemOf = safeName(label(clip).replace(/\.[^.]+$/, ""), "Grade");
      let name = `${stemOf}.cube`;
      for (let number = 2; taken.has(name); number++)
        name = `${stemOf} ${number}.cube`;
      taken.add(name);
      await writeFile(join(folder, "LUTs", name), cube, { flag: "wx" });
      gradeNotes.push(
        `Apply LUTs/${name} to "${label(clip)}" at ${formatTimecode(clip.start, fps)} on ${trackName(clip.track)}, its Cutroom grade.`,
      );
    }
  }

  const plan = planResolveTimeline({
    name: stem,
    timeline: timelineIn,
    size: source.size,
    media,
    baked: new Set(replaced.keys()),
  });
  const notes = [
    ...offline.map((path) => `${path} is offline, so its clips are left out.`),
    ...(decoded.length
      ? [
          `Resolve on Linux plays AAC sound silent, so the sound of ${decoded.join(", ")} is a WAV in the Sound folder; the pictures still link the original files.`,
        ]
      : []),
    ...plan.notes,
  ];
  const timeline = join(folder, `${stem}.fcpxml`);
  await writeFile(timeline, plan.fcpxml, { flag: "wx" });
  const markers = plan.markers ? join(folder, `${stem} markers.edl`) : null;
  if (markers && plan.markers)
    await writeFile(markers, plan.markers, { flag: "wx" });
  const summary = join(folder, "Summary.txt");
  await writeFile(
    summary,
    [
      `${stem} for DaVinci Resolve`,
      "",
      `Import the timeline with File > Import > Timeline and choose ${basename(timeline)}.`,
      ...(markers
        ? [
            `Then add the markers with Timeline > Import > Timeline Markers from EDL and choose ${basename(markers)}.`,
          ]
        : []),
      "",
      `Timeline: ${source.size.width} x ${source.size.height} at ${describeRate(fps)} fps, ${formatTimecode(source.timeline.duration, fps)} long.`,
      options.copyMedia
        ? "Media: copied into the Media folder beside the timeline."
        : "Media: linked where it is in the project.",
      ...(gradeNotes.length
        ? ["", "Grades:", ...gradeNotes.map((note) => `- ${note}`)]
        : []),
      "",
      ...(layerNotes.length
        ? ["Rendered as layers:", ...layerNotes.map((note) => `- ${note}`), ""]
        : []),
      ...(notes.length
        ? ["Not carried over:", ...notes.map((note) => `- ${note}`)]
        : ["Everything else on the timeline was carried over."]),
      "",
    ].join("\n"),
    { flag: "wx" },
  );
  return {
    outputPath: folder,
    timeline,
    markers,
    summary,
    notes: [...layerNotes, ...notes],
  };
}
