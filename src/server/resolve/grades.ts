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
    `import os
import sys
from pathlib import Path

def lut_root():
    configured = globals().get("cutroom_lut_root") or os.environ.get("BMD_RESOLVE_LUT_DIR")
    if configured:
        path = Path(configured).expanduser()
    elif sys.platform == "win32":
        path = Path(os.environ["PROGRAMDATA"]) / "Blackmagic Design" / "DaVinci Resolve" / "Support" / "LUT"
    elif sys.platform == "darwin":
        path = Path("/Library/Application Support/Blackmagic Design/DaVinci Resolve/LUT")
    else:
        path = Path("/opt/resolve/LUT")
    return path.resolve(strict=True)

def install_grades(project, export_folder, locations):
    try:
        root = lut_root()
        pending = []
        installed = {}
        for relative in sorted({entry[3] for entry in locations}):
            source = export_folder / "LUTs" / relative
            destination = root / relative
            if destination.resolve().parent != root / ${quote(LUT_FOLDER)}:
                raise RuntimeError("LUT destination resolves outside the Cutroom Grades folder: " + str(destination))
            installed[relative] = str(destination)
            if destination.exists():
                if destination.read_bytes() != source.read_bytes():
                    raise RuntimeError("A different LUT already exists at " + str(destination))
            else:
                with source.open("rb"):
                    pass
                pending.append((destination, source))
        for destination, source in pending:
            data = source.read_bytes()
            destination.parent.mkdir(exist_ok=True)
            try:
                output = destination.open("xb")
            except FileExistsError:
                if destination.read_bytes() != data:
                    raise RuntimeError("A different LUT already exists at " + str(destination))
                continue
            try:
                with output:
                    output.write(data)
            except OSError:
                destination.unlink()
                raise
    except OSError as error:
        raise RuntimeError("Could not install the Cutroom LUTs. Choose a writable LUT location already registered in Resolve. See Summary.txt. " + str(error)) from error
    if not project.RefreshLUTList():
        raise RuntimeError("Resolve could not refresh its LUT list. Check the LUT location in Summary.txt.")
    return installed

def grade_targets(imported, locations, installed):
    origin = imported.GetStartFrame()
    tracks = {}
    targets = []
    for track, start, end, lut in locations:
        where = f"V{track}, frames {start}-{end}"
        if track not in tracks:
            cuts = {}
            for item in imported.GetItemListInTrack("video", track) or []:
                cut = (item.GetStart() - origin, item.GetEnd() - origin)
                cuts.setdefault(cut, []).append(item)
            tracks[track] = cuts
        found = tracks[track].get((start, end), [])
        if len(found) != 1:
            raise RuntimeError(where + ": could not find exactly one matching clip")
        graph = found[0].GetNodeGraph()
        if not graph or graph.GetNumNodes() < 1:
            raise RuntimeError(where + ": Resolve could not read node 01")
        targets.append((where, graph, installed[lut]))
    return targets

def import_cutroom_timeline():
    project = resolve.GetProjectManager().GetCurrentProject()
    if not project:
        raise RuntimeError("Open the destination Resolve project first.")
    if project.GetSetting("colorScienceMode") != "davinciYRGB":
        raise RuntimeError("Cutroom grades need DaVinci YRGB (Rec.709). See Summary.txt.")
    # Remote grades are shared by every timeline using the same media.
    local_grades = project.GetSetting("colorUseLocalVersionsAsDefault")
    if str(local_grades).lower() not in ("1", "true"):
        raise RuntimeError("Enable Use local version for new clips in timeline. See Summary.txt.")
    path = Path(__file__).resolve().parent / ${quote(basename(fcpxml))}
    if not path.is_file():
        raise RuntimeError("The exported timeline is missing: " + str(path))
    locations = ${JSON.stringify(clips)}
    installed = install_grades(project, path.parent, locations)

    pool = project.GetMediaPool()
    previous_folder = pool.GetCurrentFolder()
    previous_timeline = project.GetCurrentTimeline()
    folder = pool.AddSubFolder(previous_folder, path.stem)
    if not folder:
        raise RuntimeError("Resolve could not create the import bin.")
    imported = None
    try:
        if not pool.SetCurrentFolder(folder):
            raise RuntimeError("Resolve could not select the import bin.")
        imported = pool.ImportTimelineFromFile(str(path), {"importSourceClips": True})
        if not imported or not project.SetCurrentTimeline(imported):
            raise RuntimeError("Resolve could not open " + path.name)
        for where, graph, lut in grade_targets(imported, locations, installed):
            if not graph.SetLUT(1, lut):
                raise RuntimeError(where + ": Resolve could not apply " + lut)
    except Exception as error:
        failed = []
        if previous_timeline and not project.SetCurrentTimeline(previous_timeline):
            failed.append("restore the previous timeline")
        if imported and not pool.DeleteTimelines([imported]):
            failed.append("remove the imported timeline")
        if not pool.SetCurrentFolder(previous_folder):
            failed.append("restore the previous bin")
        if not pool.DeleteFolders([folder]):
            failed.append("remove the import bin")
        if failed:
            raise RuntimeError(str(error) + "\\nResolve could not " + ", ".join(failed) + ".") from error
        raise
    print(f"Applied {len(locations)} Cutroom grades to {imported.GetName()}.")

import_cutroom_timeline()
`,
    { flag: "wx" },
  );
  return {
    script,
    notes,
    instructions: [
      "Import the timeline and its grades together in Resolve:",
      "Open a DaVinci YRGB destination project with a Rec.709 timeline and Use local version for new clips in timeline enabled.",
      "In Workspace > Console, select Py3 and paste this line. It installs and refreshes the LUTs, imports the timeline in a new bin and applies the grades.",
      `import runpy; runpy.run_path(${quote(script)}, init_globals={"resolve": resolve})`,
      "If you move this export, update the quoted script path.",
      "If the default LUT folder is read-only, add a writable folder once under Resolve > Preferences > System > General > LUT Locations. Paste the line below with the registered folder's absolute path:",
      `import runpy; runpy.run_path(${quote(script)}, init_globals={"resolve": resolve, "cutroom_lut_root": "/path/to/registered/LUTs"})`,
      "For a manual import, copy the LUTs into Open LUT Folder and click Update Lists in Project Settings > Color Management. Import the FCPXML and apply the grades using the clip list below.",
    ],
  };
}
