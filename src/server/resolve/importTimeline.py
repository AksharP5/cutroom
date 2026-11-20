import json
import os
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

LUT_FOLDER = "Cutroom Grades"
MINIMUM_VERSION = (21, 1, 2)


def package_file(root, name, expected):
    relative = Path(name)
    if relative.is_absolute() or ".." in relative.parts:
        raise RuntimeError(f"Invalid path in the Cutroom export: {name}")
    try:
        path = (root / relative).resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise RuntimeError(f"The Cutroom export file is missing or unreadable: {name}") from error
    if expected not in path.parents or not path.is_file():
        raise RuntimeError(f"The Cutroom export file must be a regular file inside {expected}: {name}")
    return path


def read_timeline(root, plan):
    timeline = package_file(root, plan["timeline"], root)
    if timeline.parent != root:
        raise RuntimeError("Keep the FCPXML beside the import script. See Summary.txt.")
    media = {}
    for entry in plan["media"]:
        name = entry["path"]
        if entry["packaged"]:
            parts = Path(name).parts
            if not parts or parts[0] not in ("Media", "Layers", "Sound"):
                raise RuntimeError(f"Unexpected packaged media path: {name}")
            path = package_file(root, name, root / parts[0])
        else:
            path = Path(name)
            if not path.is_absolute() or not path.is_file() or path.resolve() != path:
                raise RuntimeError(f"The original media is missing or has moved: {name}")
        media[entry["url"]] = path.as_uri()

    # Re-serialize only the XML tree. Resolve receives absolute file URLs and a fixed doctype.
    tree = ET.parse(timeline)
    seen = set()
    for node in tree.iter():
        url = node.get("src")
        if url is None:
            continue
        if node.tag != "media-rep" or url not in media:
            raise RuntimeError("The FCPXML references media outside the Cutroom import plan. Export it again.")
        seen.add(url)
        node.set("src", media[url])
    if seen != set(media):
        raise RuntimeError("The FCPXML is missing media from the Cutroom import plan. Export it again.")
    return tree


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

def install_grades(project, luts, configured):
    try:
        root = lut_root(configured)
        pending = []
        installed = {}
        for relative, source in sorted(luts.items()):
            destination = root / LUT_FOLDER / Path(relative).name
            if destination.resolve().parent != root / LUT_FOLDER:
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
    def clip_at(placement, match_end=True):
        kind, track, start = (placement[k] for k in ("kind", "track", "start"))
        where = f"{kind} track {track}, frame {start}"
        if (kind, track) not in tracks:
            cuts = {}
            for item in imported.GetItemListInTrack(kind, track) or []:
                if item.GetType() == "transition":
                    continue
                cuts.setdefault(item.GetStart() - origin, []).append(item)
            tracks[kind, track] = cuts
        found = tracks[kind, track].get(start, [])
        if match_end:
            found = [item for item in found if item.GetEnd() - origin == placement["end"]]
        if len(found) != 1:
            raise RuntimeError(where + ": could not find exactly one matching clip")
        return found[0]
    return clip_at

def import_cutroom_timeline(resolve, plan, root, configured=None):
    if tuple(int(part) for part in resolve.GetVersion()[:3]) < MINIMUM_VERSION:
        raise RuntimeError(
            "The Cutroom import command needs DaVinci Resolve 21.1.2 or later. "
            "Open Summary.txt and follow the manual FCPXML import steps."
        )
    project = resolve.GetProjectManager().GetCurrentProject()
    if not project:
        raise RuntimeError("Open the destination Resolve project first.")
    root = root.resolve(strict=True)
    tree = read_timeline(root, plan)
    grades = plan["grades"]
    luts = {
        name: package_file(root, name, root / "LUTs" / LUT_FOLDER)
        for name in sorted({grade["lut"] for grade in grades})
    }
    configured = configured or os.environ.get("BMD_RESOLVE_LUT_DIR")
    # Resolve's default color-page LUT folder on Linux belongs to root.
    fusion_grades = sys.platform.startswith("linux") and not configured
    if grades:
        if project.GetSetting("colorScienceMode") != "davinciYRGB":
            raise RuntimeError("Cutroom grades need DaVinci YRGB (Rec.709). See Summary.txt.")
        # Remote grades are shared by every timeline using the same media.
        local_grades = project.GetSetting("colorUseLocalVersionsAsDefault")
        if not fusion_grades and str(local_grades).lower() not in ("1", "true"):
            raise RuntimeError("Enable Use local version for new clips in timeline. See Summary.txt.")

    with tempfile.TemporaryDirectory(prefix="cutroom-resolve-") as directory:
        path = Path(directory) / Path(plan["timeline"]).name
        path.write_bytes(b'<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n' +
                         ET.tostring(tree.getroot(), encoding="utf-8"))
        installed = install_grades(project, luts, configured) if grades and not fusion_grades else {}
        imported = import_into_project(project, plan, path, luts, installed, fusion_grades)
    print(f"Imported {imported.GetName()} with {len(grades)} grades, {len(plan['retimes'])} speed changes, "
          f"{len(plan['transitions'])} transitions and {len(plan['markers'])} markers.")


def import_into_project(project, plan, path, luts, installed, fusion_grades):
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
        for track in plan["tracks"]:
            kind, index, name = (track[k] for k in ("kind", "index", "name"))
            if track["empty"] and not imported.AddTrack(kind, {"index": index, "audioType": "stereo"}):
                raise RuntimeError(f"Could not restore empty {kind} track {index}.")
            if name and not imported.SetTrackName(kind, index, name):
                raise RuntimeError(f"Could not name {kind} track {index} {name!r}.")
        origin = imported.GetStartFrame()
        clip_at = clip_lookup(imported)
        for retime in plan["retimes"]:
            start, end, label, percent = (retime[k] for k in ("start", "end", "label", "percent"))
            item = clip_at(retime, match_end=False)
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
        for cut in plan["transitions"]:
            kind, track, label, name, alignment, duration = (
                cut[k] for k in ("kind", "track", "label", "name", "alignment", "duration")
            )
            item = clip_at(cut)
            transition = item.AddTransition({
                "type": name, "category": "audio" if kind == "audio" else "simple", "position": "end",
                "alignment": alignment, "duration": duration,
            })
            if not transition or transition.GetProperty("TransitionDuration") != duration:
                raise RuntimeError(f"{kind} track {track}: Resolve could not add the {duration}-frame {name} "
                                   f"after {label!r}. See Summary.txt.")
        for group in plan["links"]:
            items = [clip_at(clip) for clip in group]
            if not imported.SetClipsLinked(items, True):
                raise RuntimeError(f"Resolve could not link {items[0].GetName()!r} with its sound.")
        for marker in plan["markers"]:
            frame, color, name, note, duration = (marker[k] for k in ("frame", "color", "name", "note", "duration"))
            if not imported.AddMarker(frame, color, name, note, duration):
                raise RuntimeError(f"Could not add marker {name!r} at frame {frame}.")
        for grade in plan["grades"]:
            track, start, end, lut = (grade[k] for k in ("track", "start", "end", "lut"))
            item = clip_at(grade)
            if fusion_grades:
                if not apply_fusion_grade(item, luts[lut]):
                    raise RuntimeError(f"V{track}, frames {start}-{end}: Resolve could not apply {lut} in Fusion")
            else:
                graph = item.GetNodeGraph()
                if not graph or graph.GetNumNodes() < 1 or not graph.SetLUT(1, installed[lut]):
                    raise RuntimeError(f"V{track}, frames {start}-{end}: Resolve could not apply {lut} to node 01")
        for track in plan["tracks"]:
            kind, index = track["kind"], track["index"]
            if track["locked"] and not imported.SetTrackLock(kind, index, True):
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
            raise RuntimeError(str(error) + "\nResolve could not " + ", ".join(failed) + ".") from error
        raise
    return imported
