import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { formatTimecode } from "../../shared/timeline/timecode";
import { bakeGrade } from "../grade/luts";
import type { ResolveSource } from "./export";
import type { GradeTarget } from "./plan";

const LUT_FOLDER = "Cutroom Grades";

/** JSON strings also work as Python literals, with Unicode and path escapes preserved. */
const quote = (text: string) => JSON.stringify(text);

export async function writeResolveGrades(
  { project, composition, timeline: { fps } }: ResolveSource,
  fcpxml: string,
  targets: readonly GradeTarget[],
) {
  if (!targets.length) return null;

  const folder = dirname(fcpxml);
  const luts = join(folder, "LUTs", LUT_FOLDER);
  await mkdir(luts, { recursive: true });
  const baked = new Map<string, string>();
  const clips = [];
  const notes = [];
  for (const { grade, track, start, end, label } of targets) {
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
    clips.push([track, start, end, `${LUT_FOLDER}/${name}`]);
    notes.push(
      `"${label.replace(/[\r\n]/g, " ")}" at ${formatTimecode(start, fps)} on V${track}: LUTs/${LUT_FOLDER}/${name}`,
    );
  }
  const script = join(folder, "Import with Cutroom Grades.py");
  await writeFile(
    script,
    `from pathlib import Path

def import_cutroom_timeline():
    project = resolve.GetProjectManager().GetCurrentProject()
    if not project:
        raise RuntimeError("Open the destination Resolve project first.")
    if project.GetSetting("colorScienceMode") != "davinciYRGB":
        raise RuntimeError("Cutroom grades need DaVinci YRGB (Rec.709). See Summary.txt.")
    path = Path(__file__).resolve().parent / ${quote(basename(fcpxml))}
    imported = project.GetMediaPool().ImportTimelineFromFile(str(path))
    if not imported:
        raise RuntimeError("Resolve could not import " + path.name)
    project.SetCurrentTimeline(imported)
    origin = imported.GetStartFrame()
    clip_locations = ${JSON.stringify(clips)}
    tracks = {}
    failures = []
    applied = 0
    for track, start, end, lut in clip_locations:
        where = f"V{track}, frames {start}-{end}"
        if track not in tracks:
            items = imported.GetItemListInTrack("video", track) or []
            cuts = {}
            for item in items:
                cut = (item.GetStart() - origin, item.GetEnd() - origin)
                cuts.setdefault(cut, []).append(item)
            tracks[track] = cuts
        found = tracks[track].get((start, end), [])
        if len(found) != 1:
            failures.append(where + ": could not find exactly one matching clip")
            continue
        graph = found[0].GetNodeGraph()
        if not graph or not graph.SetLUT(1, lut):
            failures.append(where + ": Resolve could not apply " + lut)
            continue
        applied += 1
    print(f"Applied {applied}/{len(clip_locations)} Cutroom grades to {imported.GetName()}.")
    if failures:
        raise RuntimeError("\\n".join(failures) + "\\nSee Summary.txt for the manual LUT assignments.")

import_cutroom_timeline()
`,
    { flag: "wx" },
  );
  return {
    script,
    notes,
    instructions: [
      "Import the timeline and its grades together in Resolve:",
      "1. Open the destination project. Use DaVinci YRGB and a Rec.709 timeline for these display-referred LUTs.",
      `2. In Project Settings > Color Management > Lookup Tables, click Open LUT Folder. Copy the ${LUT_FOLDER} folder from LUTs into it (merge folders if it already exists), then click Update Lists.`,
      "3. Open Workspace > Console, select Py3, then paste the line below. The script imports a new timeline and applies node 01 LUTs only to that timeline.",
      `import runpy; runpy.run_path(${quote(script)}, init_globals={"resolve": resolve})`,
      "If you move this export, update the quoted script path before running the command.",
      "For a manual import, choose File > Import > Timeline, then apply the LUTs on the Color page using the clip list below.",
    ],
  };
}
