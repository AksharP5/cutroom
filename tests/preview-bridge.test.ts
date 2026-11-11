import { expect, test } from "bun:test";
import { parse } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import { withPreviewBridge } from "../src/server/hyperframes/previewBridge";

function videoAttributes(source: string) {
  const visit = (
    nodes: DefaultTreeAdapterTypes.ChildNode[],
  ): Map<string, string>[] =>
    nodes.flatMap((node) => {
      if (!("tagName" in node)) return [];
      if (node.tagName === "video")
        return [new Map(node.attrs.map(({ name, value }) => [name, value]))];
      return visit(node.childNodes);
    });
  return visit(parse(withPreviewBridge(source)).childNodes);
}

test("served split boundaries use exact frames, keeping source offsets and authored fractional timing", () => {
  const [split, fractional] =
    videoAttributes(`<main data-composition-id="main" data-fps="30">
    <video data-start="3.366667" data-duration="0.033333" data-media-start="1.234567" src="picture.mp4"></video>
    <video data-start="3.3711" data-duration="0.024" src="picture.mp4"></video>
    </main>`);
  expect(Number(split!.get("data-start"))).toBe(101 / 30);
  expect(
    Number(split!.get("data-start")) + Number(split!.get("data-duration")),
  ).toBe(102 / 30);
  expect(split!.get("data-media-start")).toBe("1.234567");
  expect(split!.get("crossorigin")).toBe("anonymous");
  expect(fractional!.get("data-start")).toBe("3.3711");
  expect(fractional!.get("data-duration")).toBe("0.024");
});

test("preview boundaries follow the composition's rational frame rate and explicit ends", () => {
  const [video] =
    videoAttributes(`<main data-composition-id="main" data-fps="30000/1001">
    <div><video data-start="2.535867" data-end="2.569233" src="picture.mp4"></video></div>
    </main>`);
  expect(Number(video!.get("data-start"))).toBe((76 * 1001) / 30000);
  expect(Number(video!.get("data-end"))).toBe((77 * 1001) / 30000);
});
