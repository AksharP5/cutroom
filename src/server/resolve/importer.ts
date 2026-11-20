import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { formatTimecode } from "../../shared/timeline/timecode";
import { bakeGrade } from "../grade/luts";
import type { ResolveSource } from "./export";
import { resolveMarkerColor } from "./plan";
import type { Plan } from "./plan";

const LUT_FOLDER = "Cutroom Grades";

/** JSON strings also work as Python literals, with Unicode and path escapes preserved. */
const quote = (text: string) => JSON.stringify(text);

export async function writeResolveImporter(
  { project, composition, timeline: { fps } }: ResolveSource,
  fcpxml: string,
  { grades, transitions, retimes, links, tracks, timelineMarkers }: Plan,
) {
  if (
    !grades.length &&
    !transitions.length &&
    !retimes.length &&
    !links.length &&
    !tracks.length &&
    !timelineMarkers.length
  )
    return null;

  const folder = dirname(fcpxml);
  const luts = join(folder, "LUTs", LUT_FOLDER);
  if (grades.length) await mkdir(luts, { recursive: true });
  const baked = new Map<string, string>();
  const clips = [];
  const notes = [];
  for (const { grade, track, start, end, label } of grades) {
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
  const markerRows = timelineMarkers.map(
    ({ frame, color, name, note, duration }) => [
      frame,
      resolveMarkerColor[color],
      name || "Marker",
      note,
      Math.max(1, duration),
    ],
  );
  const transitionRows = transitions.map(
    ({ track, start, end, label, transition }) => [
      track,
      start,
      end,
      label,
      transition.kind === "dissolve"
        ? "Cross Dissolve"
        : "Dip To Color Dissolve",
      { start: "right", center: "center", end: "left" }[transition.alignment],
      transition.duration,
    ],
  );
  const retimeRows = retimes.map(
    ({ kind, track, start, end, label, percent }) => [
      kind,
      track,
      start,
      end,
      label,
      percent,
    ],
  );
  const linkRows = links.map((group) =>
    group.map(({ kind, track, start, end }) => [kind, track, start, end]),
  );
  const trackRows = tracks.map(({ kind, index, empty, name, locked }) => [
    kind,
    index,
    Number(empty),
    name ?? "",
    Number(locked),
  ]);
  const script = join(folder, "Import Cutroom Timeline.py");
  await writeFile(
    script,
    `import os
import sys
from pathlib import Path

def lut_root(configured):
    if configured:
        path = Path(configured).expanduser()
    elif sys.platform == "win32":
        path = Path(os.environ["PROGRAMDATA"]) / "Blackmagic Design" / "DaVinci Resolve" / "Support" / "LUT"
    elif sys.platform == "darwin":
        path = Path("/Library/Application Support/Blackmagic Design/DaVinci Resolve/LUT")
    else:
        path = Path("/opt/resolve/LUT")
    return path.resolve(strict=True)

def install_grades(project, export_folder, locations, configured):
    try:
        root = lut_root(configured)
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

def apply_fusion_grade(item, lut_path):
    comp = item.AddFusionComp()
    if not comp:
        return False
    media_in = comp.FindTool("MediaIn1")
    media_out = comp.FindTool("MediaOut1")
    grade = comp.AddTool("FileLUT")
    if not media_in or not media_out or not grade:
        return False
    grade.SetInput("LUTFile", str(lut_path))
    grade.SetInput("ProcessAlpha", 0)
    # A connected graph can be present in the editor and still be skipped in the render.
    return (
        grade.GetInput("LUTFile") == str(lut_path)
        and grade.ConnectInput("Input", media_in)
        and media_out.ConnectInput("Input", grade)
        and item.LoadFusionCompByName(item.GetFusionCompNameList()[-1]) is not None
    )

def clip_lookup(imported):
    origin = imported.GetStartFrame()
    tracks = {}
    def clip_at(kind, track, start, end=None):
        where = f"{kind} track {track}, frame {start}"
        if (kind, track) not in tracks:
            cuts = {}
            for item in imported.GetItemListInTrack(kind, track) or []:
                if item.GetType() == "transition":
                    continue
                cuts.setdefault(item.GetStart() - origin, []).append(item)
            tracks[kind, track] = cuts
        found = tracks[kind, track].get(start, [])
        if end is not None:
            found = [item for item in found if item.GetEnd() - origin == end]
        if len(found) != 1:
            raise RuntimeError(where + ": could not find exactly one matching clip")
        return found[0]
    return clip_at

def import_cutroom_timeline():
    project = resolve.GetProjectManager().GetCurrentProject()
    if not project:
        raise RuntimeError("Open the destination Resolve project first.")
    locations = ${JSON.stringify(clips)}
    markers = ${JSON.stringify(markerRows)}
    transitions = ${JSON.stringify(transitionRows)}
    retimes = ${JSON.stringify(retimeRows)}
    links = ${JSON.stringify(linkRows)}
    tracks = ${JSON.stringify(trackRows)}
    configured = globals().get("cutroom_lut_root") or os.environ.get("BMD_RESOLVE_LUT_DIR")
    # Resolve's default color-page LUT folder on Linux belongs to root.
    fusion_grades = sys.platform.startswith("linux") and not configured
    if locations:
        if project.GetSetting("colorScienceMode") != "davinciYRGB":
            raise RuntimeError("Cutroom grades need DaVinci YRGB (Rec.709). See Summary.txt.")
        # Remote grades are shared by every timeline using the same media.
        local_grades = project.GetSetting("colorUseLocalVersionsAsDefault")
        if not fusion_grades and str(local_grades).lower() not in ("1", "true"):
            raise RuntimeError("Enable Use local version for new clips in timeline. See Summary.txt.")
    path = Path(__file__).resolve().parent / ${quote(basename(fcpxml))}
    if not path.is_file():
        raise RuntimeError("The exported timeline is missing: " + str(path))
    installed = install_grades(project, path.parent, locations, configured) if locations and not fusion_grades else {}

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
        names = {project.GetTimelineByIndex(i).GetName() for i in range(1, project.GetTimelineCount() + 1)}
        name = path.stem
        version = 2
        while name in names:
            name = f"{path.stem} ({version})"
            version += 1
        imported = pool.ImportTimelineFromFile(str(path), {"importSourceClips": True, "timelineName": name})
        if not imported or not project.SetCurrentTimeline(imported):
            raise RuntimeError("Resolve could not open " + path.name)
        for kind, index, empty, name, locked in tracks:
            if empty and not imported.AddTrack(kind, {"index": index, "audioType": "stereo"}):
                raise RuntimeError(f"Could not restore empty {kind} track {index}.")
            if name and not imported.SetTrackName(kind, index, name):
                raise RuntimeError(f"Could not name {kind} track {index} {name!r}.")
        origin = imported.GetStartFrame()
        clip_at = clip_lookup(imported)
        for kind, track, start, end, label, percent in retimes:
            item = clip_at(kind, track, start)
            media = item.GetMediaPoolItem()
            if not media or not media.GetClipProperty("File Path"):
                raise RuntimeError(f"Resolve did not link the original media for {label!r}.")
            source_in = item.GetSourceStartTime()
            if not item.SetSpeed({"Percentage": percent, "RippleTimeline": False, "PitchCorrection": True}):
                raise RuntimeError(f"Could not set {label!r} to {percent}% speed.")
            # The 100% placeholder may be shortened at EOF on a slow clip.
            extra = end - (item.GetEnd() - origin)
            if extra and not item.SetRightOffset(item.GetRightOffset() - extra, False, False):
                raise RuntimeError(f"Could not restore the cut length of {label!r} after retiming.")
            if item.GetStart() - origin != start or item.GetEnd() - origin != end:
                raise RuntimeError(f"Resolve moved a cut while retiming {label!r}.")
            if abs(item.GetSourceStartTime() - source_in) > 0.001:
                raise RuntimeError(f"Resolve changed the source in-point while retiming {label!r}.")
        clip_at = clip_lookup(imported)
        for track, start, end, label, name, alignment, duration in transitions:
            item = clip_at("video", track, start, end)
            transition = item.AddTransition({
                "type": name, "category": "simple", "position": "end",
                "alignment": alignment, "duration": duration,
            })
            if not transition or transition.GetProperty("TransitionDuration") != duration:
                raise RuntimeError(f"V{track}: Resolve could not add the {duration}-frame {name} after {label!r}.")
        for group in links:
            items = [clip_at(*location) for location in group]
            if not imported.SetClipsLinked(items, True):
                raise RuntimeError(f"Resolve could not link {items[0].GetName()!r} with its sound.")
        for frame, color, name, note, duration in markers:
            if not imported.AddMarker(frame, color, name, note, duration):
                raise RuntimeError(f"Could not add marker {name!r} at frame {frame}.")
        for track, start, end, lut in locations:
            item = clip_at("video", track, start, end)
            if fusion_grades:
                lut_path = (path.parent / "LUTs" / lut).resolve(strict=True)
                if not apply_fusion_grade(item, lut_path):
                    raise RuntimeError(f"V{track}, frames {start}-{end}: Resolve could not apply {lut} in Fusion")
            else:
                graph = item.GetNodeGraph()
                if not graph or graph.GetNumNodes() < 1 or not graph.SetLUT(1, installed[lut]):
                    raise RuntimeError(f"V{track}, frames {start}-{end}: Resolve could not apply {lut} to node 01")
        for kind, index, empty, name, locked in tracks:
            if locked and not imported.SetTrackLock(kind, index, True):
                raise RuntimeError(f"Could not lock {kind} track {index}.")
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
    print(f"Imported {imported.GetName()} with {len(locations)} grades, {len(retimes)} speed changes, {len(transitions)} transitions and {len(markers)} markers.")

import_cutroom_timeline()
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
      "In Workspace > Console, select Py3 and paste this line to import the Cutroom timeline in a new bin.",
      `import runpy; runpy.run_path(${quote(script)}, init_globals={"resolve": resolve})`,
      "If you move this export, update the quoted script path.",
      `For a manual import, choose File > Import > Timeline and open ${basename(fcpxml)}.`,
      ...retimes.map(
        ({ kind, track, start, label, percent }) =>
          `If you import the FCPXML by hand, "${label}" on ${kind === "video" ? "V" : "A"}${track} at ${formatTimecode(start, fps)} plays at 100%. Use Change Clip Speed to set it to ${percent}% and check the cut against Cutroom.`,
      ),
      ...transitions.map(
        ({ track, end, transition }) =>
          `If you import the FCPXML by hand, add a ${transition.duration}-frame ${transition.kind === "dissolve" ? "Cross Dissolve" : "Dip To Color Dissolve"} on V${track} at ${formatTimecode(end, fps)}. Align it to the ${transition.alignment} of the cut.`,
      ),
      ...(links.length
        ? [
            "If you import the FCPXML by hand, select the separately imported picture and sound on the Edit page and use Link Clips.",
          ]
        : []),
      ...(tracks.length
        ? [
            "If you import the FCPXML by hand, restore any empty tracks, track names and locks using the track headers on the Edit page.",
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
