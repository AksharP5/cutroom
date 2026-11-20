"""Run the actual exported Python command with just the Resolve operations this edit needs."""
import os
import runpy
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from types import SimpleNamespace

folder, lut_root = map(Path, sys.argv[1:])
script = folder / "Import Cutroom Timeline.py"
xml = folder / "Portable.fcpxml"
media = folder / "Media" / "camera #1.mov"
lut = next(folder.glob("LUTs/Cutroom Grades/*.cube"))
os.environ.pop("BMD_RESOLVE_LUT_DIR", None)


class Edit:
    def __init__(self, fail_marker=False):
        self.actions = []
        self.previous = SimpleNamespace(GetName=lambda: "Portable")
        self.current = self.previous
        self.current_bin = "existing bin"
        self.cut_end = 136
        self.empty_track_added = False
        self.fail_marker = fail_marker
        self.imported = SimpleNamespace(
            GetName=lambda: "Portable (3)",
            GetStartFrame=lambda: 100,
            AddTrack=self.add_track,
            SetTrackName=self.track_name,
            GetItemListInTrack=self.items,
            AddMarker=self.marker,
            SetTrackLock=self.track_lock,
        )
        self.item = SimpleNamespace(
            GetType=lambda: "video",
            GetStart=lambda: 112,
            GetEnd=lambda: self.cut_end,
            GetMediaPoolItem=lambda: SimpleNamespace(GetClipProperty=lambda key: str(media)),
            GetSourceStartTime=lambda: 1.5,
            GetRightOffset=lambda: 24,
            SetSpeed=self.speed,
            SetRightOffset=self.extend,
            GetNodeGraph=lambda: SimpleNamespace(GetNumNodes=lambda: 1, SetLUT=self.apply_lut),
        )

    def called(self, *action):
        self.actions.append(action)
        return True

    def GetSetting(self, key):
        return {"colorScienceMode": "davinciYRGB", "colorUseLocalVersionsAsDefault": "1"}[key]

    def RefreshLUTList(self):
        return self.called("refresh LUTs")

    def GetMediaPool(self):
        return self

    def GetCurrentFolder(self):
        return self.current_bin

    def GetCurrentTimeline(self):
        return self.current

    def GetTimelineCount(self):
        return 2

    def GetTimelineByIndex(self, index):
        return self.previous if index == 1 else SimpleNamespace(GetName=lambda: "Portable (2)")

    def AddSubFolder(self, parent, name):
        assert (parent, name) == ("existing bin", "Portable")
        self.called("add bin")
        return "import bin"

    def SetCurrentFolder(self, folder):
        self.current_bin = folder
        return self.called("select bin", folder)

    def SetCurrentTimeline(self, timeline):
        self.current = timeline
        return self.called("select timeline", timeline.GetName())

    def ImportTimelineFromFile(self, path, options):
        assert options == {"importSourceClips": True, "timelineName": "Portable (3)"}
        assert [node.get("src") for node in ET.parse(path).iter("media-rep")] == [media.as_uri()]
        return self.imported

    def DeleteTimelines(self, timelines):
        assert timelines == [self.imported]
        return self.called("delete failed timeline")

    def DeleteFolders(self, folders):
        assert folders == ["import bin"]
        return self.called("delete failed bin")

    def add_track(self, kind, options):
        assert (kind, options["index"]) == ("video", 2)
        self.empty_track_added = True
        return self.called("add empty track")

    def track_name(self, kind, index, name):
        assert (kind, index, name) == ("video", 2, "Spare")
        return self.called("name empty track")

    def track_lock(self, kind, index, locked):
        assert (kind, index, locked) == ("video", 2, True)
        return self.called("lock empty track")

    def items(self, kind, index):
        assert self.empty_track_added and (kind, index) == ("video", 3)
        return [self.item]

    def speed(self, options):
        assert options == {"Percentage": 50, "RippleTimeline": False, "PitchCorrection": True}
        return self.called("set speed")

    def extend(self, offset, subframes, linked):
        assert (offset, subframes, linked) == (0, False, False)
        self.cut_end = 160
        return self.called("extend to requested cut")

    def marker(self, frame, color, name, note, duration):
        assert (frame, color, name, note, duration) == (
            7, "Cyan", "Lead \ufffd\ncue", "First line\nCafé\ufffd", 5,
        )
        return self.called("add marker") and not self.fail_marker

    def apply_lut(self, node, path):
        assert (node, self.cut_end) == (1, 160)
        assert Path(path).read_bytes() == lut.read_bytes()
        return self.called("apply grade")

    def run(self, version=(21, 1, 2)):
        resolve = SimpleNamespace(
            GetVersion=lambda: version,
            GetProjectManager=lambda: SimpleNamespace(GetCurrentProject=lambda: self),
        )
        runpy.run_path(str(script), init_globals={"resolve": resolve, "cutroom_lut_root": str(lut_root)})


def refused(edit, message, **kwargs):
    try:
        edit.run(**kwargs)
    except RuntimeError as error:
        assert message in str(error), str(error)
    else:
        raise AssertionError("The import should have refused before touching the project.")


old = Edit()
refused(old, "21.1.2 or later", version=(21, 1, 1))
assert old.actions == [] and not list(lut_root.iterdir())

for required in (xml, media, lut):
    outside = folder.parent / required.name
    required.replace(outside)
    try:
        missing = Edit()
        refused(missing, "missing or unreadable")
        assert not missing.actions and not list(lut_root.iterdir())
        required.symlink_to(outside)
        redirected = Edit()
        refused(redirected, "must be a regular file inside")
        assert not redirected.actions and not list(lut_root.iterdir())
    finally:
        if required.is_symlink():
            required.unlink()
        outside.replace(required)

succeeded = Edit()
succeeded.run()
assert succeeded.current is succeeded.imported
assert succeeded.actions[-5:] == [
    ("set speed",), ("extend to requested cut",), ("add marker",), ("apply grade",), ("lock empty track",),
]

failed = Edit(fail_marker=True)
refused(failed, "Could not add marker")
assert failed.current is failed.previous and failed.current_bin == "existing bin"
assert failed.actions[-4:] == [
    ("select timeline", "Portable"), ("delete failed timeline",),
    ("select bin", "existing bin"), ("delete failed bin",),
]
