"""Run the Resolve export when adjacent stereo cuts import on one track."""
import runpy
import sys
from pathlib import Path
from types import SimpleNamespace

script, music = map(Path, sys.argv[1:])
mic = script.parent / "Sound" / "mic sound.wav"
tracks = [[]]


class Item:
    def __init__(self, path, start):
        self.path = path
        self.start = start
        self.fades = {}
        tracks[0].append(self)

    def GetType(self):
        return "audio"

    def GetStart(self):
        return self.start

    def GetEnd(self):
        return self.start + 24

    def GetMediaPoolItem(self):
        return SimpleNamespace(GetClipProperty=lambda key: str(self.path))

    def SetPosition(self, placement, linked, subframes):
        assert not linked and not subframes
        track = placement["trackIndex"]
        for items in tracks:
            if self in items:
                items.remove(self)
                break
        tracks[track - 1].append(self)
        return True

    def SetFades(self, fades):
        self.fades = fades
        return True

    def GetFades(self):
        return self.fades


mic_item, music_item = Item(mic, 0), Item(music, 24)


def add_track(kind, options):
    assert kind == "audio" and options["audioType"] == "stereo"
    tracks.append([])
    return True


def delete_track(kind, index):
    assert kind == "audio" and not tracks[index - 1]
    del tracks[index - 1]
    return True


timeline = SimpleNamespace(
    GetName=lambda: "Dialogue",
    GetStartFrame=lambda: 0,
    GetItemListInTrack=lambda kind, index: tracks[index - 1] if kind == "audio" else [],
    GetTrackCount=lambda kind: len(tracks) if kind == "audio" else 1,
    AddTrack=add_track,
    DeleteTrack=delete_track,
)
pool = SimpleNamespace(
    GetCurrentFolder=lambda: "root",
    AddSubFolder=lambda parent, name: "import",
    SetCurrentFolder=lambda folder: True,
    ImportTimelineFromFile=lambda path, options: timeline,
)
project = SimpleNamespace(
    GetMediaPool=lambda: pool,
    GetCurrentTimeline=lambda: None,
    GetTimelineCount=lambda: 0,
    SetCurrentTimeline=lambda timeline: True,
)
resolve = SimpleNamespace(
    GetVersion=lambda: (21, 1, 2),
    GetProjectManager=lambda: SimpleNamespace(GetCurrentProject=lambda: project),
)
runpy.run_path(str(script), init_globals={"resolve": resolve})
assert tracks == [[mic_item], [music_item]]
assert mic_item.fades == {"FadeIn": 6, "FadeOut": 0}
