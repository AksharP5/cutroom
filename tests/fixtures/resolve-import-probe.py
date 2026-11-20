"""Run the actual exported Python command with just the Resolve operations this edit needs."""
import os
import runpy
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

folder, lut_root = map(Path, sys.argv[1:])
script = folder / "Import Cutroom Timeline.py"
xml = folder / "Portable.fcpxml"
media = folder / "Media" / "camera #1.mov"
audio = folder / "Media" / "voice.wav"
lut = next(folder.glob("LUTs/Cutroom Grades/*.cube"))
os.environ.pop("BMD_RESOLVE_LUT_DIR", None)


class Edit:
    def __init__(self, fail_marker=False, fail_grade=False, audio_link=audio):
        self.actions = []
        self.previous = SimpleNamespace(GetName=lambda: "Portable")
        self.current = self.previous
        self.current_bin = "existing bin"
        self.cut_end = 136
        self.empty_track_added = False
        self.fail_marker = fail_marker
        self.fail_grade = fail_grade
        self.imported = SimpleNamespace(
            GetName=lambda: "Portable (3)",
            GetStartFrame=lambda: 100,
            AddTrack=self.add_track,
            SetTrackName=self.track_name,
            GetTrackCount=lambda kind: 3 if kind == "video" else 1,
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
            AddFusionComp=self.fusion_comp,
            GetFusionCompNameList=lambda: ["Cutroom"],
            LoadFusionCompByName=self.load_fusion_comp,
        )
        self.audio = [
            SimpleNamespace(
                GetType=lambda: "audio",
                GetStart=lambda index=index: 112 + index * 24,
                GetEnd=lambda index=index: 136 + index * 24,
                GetMediaPoolItem=lambda: SimpleNamespace(
                    GetClipProperty=lambda key: str(audio_link or ""),
                ),
                AddTransition=self.add_transition,
            )
            for index in range(2)
        ]

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
        assert {node.get("src") for node in ET.parse(path).iter("media-rep")} == {
            media.as_uri(), audio.as_uri(),
        }
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
        assert self.empty_track_added
        if kind == "audio":
            assert index == 1
            return self.audio
        return [self.item] if index == 3 else []

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

    def add_transition(self, options):
        assert options == {
            "type": "Cross Fade +3 dB", "category": "audio", "position": "end",
            "alignment": "center", "duration": 12,
        }
        self.called("add audio crossfade")
        return SimpleNamespace(GetProperty=lambda key: {"TransitionDuration": 12}[key])

    def apply_lut(self, node, path):
        assert (node, self.cut_end) == (1, 160)
        assert Path(path).read_bytes() == lut.read_bytes()
        return self.called("apply grade") and not self.fail_grade

    def fusion_comp(self):
        self.called("add Fusion comp")
        inputs = {}
        media_in = object()
        file_lut = SimpleNamespace(
            SetInput=lambda key, value: inputs.update({key: value}),
            GetInput=lambda key: inputs[key],
            ConnectInput=lambda key, value: (key, value) == ("Input", media_in),
        )
        media_out = SimpleNamespace(
            ConnectInput=lambda key, value: (key, value) == ("Input", file_lut)
            and inputs == {"LUTFile": str(lut), "ProcessAlpha": 0}
            and self.called("connect Fusion File LUT"),
        )
        return SimpleNamespace(
            FindTool=lambda name: {"MediaIn1": media_in, "MediaOut1": media_out}[name],
            AddTool=lambda kind: {"FileLUT": file_lut}[kind],
        )

    def load_fusion_comp(self, name):
        assert name == "Cutroom"
        return self.called("load Fusion comp")

    def run(self, version=(21, 1, 2), fusion=False):
        resolve = SimpleNamespace(
            GetVersion=lambda: version,
            GetProjectManager=lambda: SimpleNamespace(GetCurrentProject=lambda: self),
        )
        globals_ = {"resolve": resolve}
        if not fusion:
            globals_["cutroom_lut_root"] = str(lut_root)
        with patch.object(sys, "platform", "linux" if fusion else sys.platform):
            runpy.run_path(str(script), init_globals=globals_)


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

for required in (xml, media, audio, lut):
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

for incorrect in (None, media):
    unlinked = Edit(audio_link=incorrect)
    refused(unlinked, "Resolve did not link 'Voice take 1'")
    assert unlinked.current is unlinked.previous and not list(lut_root.iterdir())
    assert ("add audio crossfade",) not in unlinked.actions
    assert ("add marker",) not in unlinked.actions

fusion = Edit()
fusion.run(fusion=True)
assert fusion.current is fusion.imported and not list(lut_root.iterdir())
assert fusion.actions[-8:] == [
    ("set speed",), ("extend to requested cut",), ("add audio crossfade",), ("add marker",),
    ("add Fusion comp",), ("connect Fusion File LUT",), ("load Fusion comp",), ("lock empty track",),
]

failed = Edit(fail_marker=True)
refused(failed, "Could not add marker")
assert failed.current is failed.previous and failed.current_bin == "existing bin"
assert not list(lut_root.iterdir()) and ("refresh LUTs",) not in failed.actions
assert failed.actions[-4:] == [
    ("select timeline", "Portable"), ("delete failed timeline",),
    ("select bin", "existing bin"), ("delete failed bin",),
]

installed = lut_root / "Cutroom Grades" / lut.name
failed_grade = Edit(fail_grade=True)
refused(failed_grade, "Resolve could not apply")
assert failed_grade.current is failed_grade.previous and not installed.exists()
assert failed_grade.actions.count(("refresh LUTs",)) == 2

succeeded = Edit()
succeeded.run()
assert succeeded.current is succeeded.imported and installed.read_bytes() == lut.read_bytes()
assert succeeded.actions[-6:] == [
    ("extend to requested cut",), ("add audio crossfade",), ("add marker",), ("refresh LUTs",),
    ("apply grade",), ("lock empty track",),
]

failed_again = Edit(fail_grade=True)
refused(failed_again, "Resolve could not apply")
assert installed.read_bytes() == lut.read_bytes()
