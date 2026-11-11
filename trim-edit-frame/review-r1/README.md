# Portrait roll labels

Before: PR #72 at 0d7c903df43a34f22698d2244055b9cddfaba7db.
After: 82c71331df96edd2f2f1ef150a1c65230cf8737c.

Both captures hold a roll 24 frames to the right in the same 9:16 fixture.
The outgoing source frame is 203, the incoming source frame is 324, and the playhead is parked at timeline frame 30.

At 1280x800, the old incoming timecode is clipped by the picture's right edge.
The new two-line labels stay within each half at both 1280x800 and 1720x1050.
The browser regression checks the label element and rendered text bounds against their half and the visible picture.
