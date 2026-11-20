import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { formatTimecode } from "../../shared/timeline/timecode";
import { bakeGrade } from "../grade/luts";
import type { ResolveSource } from "./export";
import { fileUrl } from "./fcpxml";
import { resolveMarkerColor } from "./plan";
import type { Plan } from "./plan";
import { oneLine, wellFormed } from "./text";

const LUT_FOLDER = "Cutroom Grades";

/** JSON strings also work as Python literals, with Unicode and path escapes preserved. */
const quote = (text: string) => JSON.stringify(text);

export async function writeResolveImporter(
  { project, composition, timeline: { fps } }: ResolveSource,
  fcpxml: string,
  {
    grades,
    transitions,
    retimes,
    fades,
    links,
    tracks,
    timelineMarkers,
    mediaPaths,
  }: Plan,
) {
  const folder = dirname(fcpxml);
  const luts = join(folder, "LUTs", LUT_FOLDER);
  if (grades.length) await mkdir(luts, { recursive: true });
  const baked = new Map<string, string>();
  const clips = [];
  const notes = [];
  for (const { grade, ...placement } of grades) {
    const key = JSON.stringify(grade);
    let name = baked.get(key);
    if (!name) {
      const cube = await bakeGrade(project, composition, grade, 65);
      // The same grade settings can reference different LUT contents in two exports.
      const hash = createHash("sha256").update(key).update(cube).digest("hex");
      name = `${hash}.cube`;
      await writeFile(join(luts, name), cube, { flag: "wx" });
      baked.set(key, name);
    }
    const lut = `LUTs/${LUT_FOLDER}/${name}`;
    clips.push({ ...placement, lut });
    notes.push(
      `"${placement.label}" at ${formatTimecode(placement.start, fps)} on V${placement.track}: ${lut}`,
    );
  }
  const importPlan = {
    timeline: basename(fcpxml),
    media: mediaPaths.map((path) => {
      const fromFolder = relative(folder, path);
      const packaged =
        !isAbsolute(fromFolder) &&
        fromFolder !== ".." &&
        !fromFolder.startsWith(`..${sep}`);
      return {
        url: fileUrl(path),
        path: packaged ? fromFolder.split(sep).join("/") : path,
        packaged,
      };
    }),
    grades: clips,
    markers: timelineMarkers.map(({ frame, color, name, note, duration }) => ({
      frame,
      color: resolveMarkerColor[color],
      name: name || "Marker",
      note,
      duration: Math.max(1, duration),
    })),
    transitions: transitions.map(({ transition, ...placement }) => ({
      ...placement,
      name:
        placement.kind === "audio"
          ? placement.linear
            ? "Cross Fade 0 dB"
            : "Cross Fade +3 dB"
          : transition.kind === "dissolve"
            ? "Cross Dissolve"
            : "Dip To Color Dissolve",
      alignment: { start: "right", center: "center", end: "left" }[
        transition.alignment
      ],
      duration: transition.duration,
    })),
    retimes,
    fades,
    links,
    tracks,
  };
  const script = join(folder, "Import Cutroom Timeline.py");
  await writeFile(
    script,
    `${await Bun.file(new URL("./importTimeline.py", import.meta.url)).text()}
import_cutroom_timeline(resolve, json.loads(${quote(
      JSON.stringify(importPlan, (_, value: unknown) =>
        typeof value === "string" ? wellFormed(value) : value,
      ),
    )}), Path(__file__).parent, globals().get("cutroom_lut_root"))

`,
    { flag: "wx" },
  );
  return {
    script,
    notes,
    instructions: [
      ...(grades.length
        ? [
            "Open a DaVinci YRGB destination project with a Rec.709 timeline.",
            "On Linux, the command reads the exported LUTs in each graded clip’s File LUT node in Fusion. Keep the LUTs folder at its imported location.",
            "On macOS and Windows, enable Use local version for new clips in timeline. The command applies the grades on Color node 01.",
          ]
        : ["Open the destination project in Resolve."]),
      "The console command requires DaVinci Resolve 21.1.2 or later.",
      "In Workspace > Console, select Py3 and paste this line to import the Cutroom timeline in a new bin.",
      `import runpy; runpy.run_path(${quote(script)}, init_globals={"resolve": resolve})`,
      "If you move this export, keep its contents together and update the quoted script path. Linked originals must stay where they were.",
      `For a manual import, choose File > Import > Timeline and open ${oneLine(basename(fcpxml))}. If you moved the package, relink any offline clips to Media, Layers or Sound inside the new folder.`,
      ...tracks.map(({ kind, index, empty, name, locked }) => {
        const track = `${kind === "video" ? "V" : "A"}${index}`;
        const edits = [
          ...(empty ? ["insert an empty track"] : []),
          ...(name ? [`name it "${oneLine(name)}"`] : []),
          ...(locked ? ["lock it after applying the other edits"] : []),
        ];
        return `For a manual import, on ${track}, ${edits.join(", then ")}.`;
      }),
      ...retimes.map(
        ({ kind, track, start, end, label, percent }) =>
          `If you import the FCPXML by hand, "${label}" on ${kind === "video" ? "V" : "A"}${track} at ${formatTimecode(start, fps)} plays at 100%. Set Change Clip Speed to ${percent}% with Ripple Timeline off. Leave Stretch Keyframes to Fit off. Keep the source in-point and trim or extend the end to ${formatTimecode(end, fps)}.`,
      ),
      ...fades.map(({ track, start, label, fadeIn, fadeOut }) => {
        const lengths = [
          ...(fadeIn ? [`a ${Number(fadeIn.toFixed(2))}-frame fade-in`] : []),
          ...(fadeOut
            ? [`a ${Number(fadeOut.toFixed(2))}-frame fade-out`]
            : []),
        ];
        return `If you import the FCPXML by hand, use the audio fade handles in Resolve to add ${lengths.join(" and ")} to "${label}" on A${track} at ${formatTimecode(start, fps)}.`;
      }),
      ...importPlan.transitions.map(
        ({ kind, track, end, name, duration, alignment }) =>
          `If you import the FCPXML by hand, add a ${duration}-frame ${name} on ${kind === "video" ? "V" : "A"}${track} at ${formatTimecode(end, fps)}. ${{ right: "Start it at the cut.", center: "Center it on the cut.", left: "End it at the cut." }[alignment]}`,
      ),
      ...(links.length
        ? [
            "If you import the FCPXML by hand, select the separately imported picture and sound on the Edit page and use Link Clips.",
          ]
        : []),
      ...(grades.length
        ? [
            "To apply grades on the Color page using your own LUT folder, register a writable folder under Resolve > Preferences > System > General > LUT Locations. Enable Use local version for new clips in timeline, then paste this line with your LUT folder’s absolute path.",
            `import runpy; runpy.run_path(${quote(script)}, init_globals={"resolve": resolve, "cutroom_lut_root": "/path/to/registered/LUTs"})`,
            "For a manual import on Linux, open each listed clip in Fusion, insert a File LUT between MediaIn and MediaOut, and choose its .cube file from LUTs.",
            "For a manual Color-page import, copy the LUTs into Open LUT Folder and click Update Lists in Project Settings > Color Management. Import the FCPXML and apply the grades using the clip list below.",
          ]
        : []),
    ],
  };
}
