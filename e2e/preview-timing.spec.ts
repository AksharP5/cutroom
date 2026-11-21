import { execFile } from "node:child_process";
import { writeFile, readFile, mkdir, chmod, rename } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { APIRequestContext, Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import type { CommandInput } from "../src/shared/timeline/schema";
import { interviewWorkload } from "../scripts/interview-performance";
import { expect, test } from "./fixtures";
import { waitForPreview } from "./preview-ready";

const token = (page: Page) =>
  page.locator(".edit-stage").getAttribute("data-preview-ready");
const live = (page: Page) =>
  page.locator("iframe[data-live]").getAttribute("src");

async function replaceIndex(dir: string, html: string) {
  const pending = join(dir, ".cutroom", "preview-next.html");
  await mkdir(join(dir, ".cutroom"), { recursive: true });
  await writeFile(pending, html);
  await rename(pending, join(dir, "index.html"));
}

async function fixture(
  request: APIRequestContext,
  page: Page,
  scripts = "",
  css = "",
  /** One clip per line, as a hand-written or editor-indented source has them. */
  indented = false,
) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Live timing", width: 640, height: 360, duration: 10 },
      })
    ).json(),
  );
  await promisify(execFile)("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=640x360:r=30000/1001:d=10",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=10",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-threads",
    "2",
    "-c:a",
    "aac",
    "-shortest",
    join(project.path, "talk.mp4"),
  ]);
  const composition = `<!doctype html><html><head><style>html,body{margin:0;background:#111}main{position:relative;width:640px;height:360px}video{position:absolute;inset:0;width:100%;height:100%}#title{position:absolute;top:20px;left:20px;color:white;font:24px sans-serif}${css}</style></head><body><main id="main" data-composition-id="main" data-no-timeline data-width="640" data-height="360" data-fps="30000/1001" data-duration="10"><video id="v1" src="talk.mp4" muted data-link="p1" data-start="0" data-duration="2.535867" data-media-start="0" data-track-index="0"></video><audio id="a1" src="talk.mp4" data-link="p1" data-start="0" data-duration="2.535867" data-media-start="0" data-track-index="1"></audio><video id="v2" src="talk.mp4" muted data-link="p2" data-start="2.535867" data-duration="7.464133" data-media-start="2.535867" data-track-index="0"></video><audio id="a2" src="talk.mp4" data-link="p2" data-start="2.535867" data-duration="7.464133" data-media-start="2.535867" data-track-index="1"></audio><div id="title" class="clip" data-start="1" data-duration="3" data-track-index="2">Chapter one</div></main></body></html>`;
  await writeFile(
    join(project.path, "index.html"),
    indented
      ? composition
          .replace(/<(video|audio|div) /g, "\n    <$1 ")
          .replace("</main>", "\n  </main>")
      : composition,
  );

  const read = async () =>
    TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    );
  const edit = async (commands: CommandInput[]) => {
    const view = await read();
    const response = await request.post(
      `/api/cutroom/projects/${project.id}/commands`,
      {
        data: {
          composition: "index.html",
          expectedRevision: view.revision,
          label: "Timing test",
          commands,
        },
      },
    );
    expect(response.ok(), await response.text()).toBe(true);
  };
  if (scripts) {
    const path = join(project.path, "index.html");
    await writeFile(
      path,
      (await readFile(path, "utf8")).replace("</body>", scripts + "</body>"),
    );
  }
  // Establish the editor's managed track stylesheet before measuring timing-only changes.
  await edit([{ type: "move", clipIds: ["title"], by: 1, mode: "overwrite" }]);
  await edit([{ type: "move", clipIds: ["title"], by: -1, mode: "overwrite" }]);
  await page.goto(`/#project/${project.id}`);
  await waitForPreview(page);
  if (!scripts) await waitForPreview(page, { timing: true });
  return { project, read, edit };
}

async function seek(page: Page, frame: number) {
  await page.getByRole("button", { name: /^Current time/ }).click();
  await page
    .getByLabel("Go to time")
    .pressSequentially(
      `${String(Math.floor(frame / 30)).padStart(2, "0")}${String(frame % 30).padStart(2, "0")}`,
    );
  await page.keyboard.press("Enter");
  await page.evaluate(async () => {
    const frame =
      document.querySelector<HTMLIFrameElement>("iframe[data-live]")!;
    const id = crypto.randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        removeEventListener("message", receive);
        reject(Error("paint timeout"));
      }, 10000);
      const receive = (event: MessageEvent) => {
        if (event.source !== frame.contentWindow || event.data?.id !== id)
          return;
        clearTimeout(timer);
        removeEventListener("message", receive);
        event.data.error ? reject(Error(event.data.error)) : resolve();
      };
      addEventListener("message", receive);
      frame.contentWindow!.postMessage(
        { source: "cutroom-viewer", id, action: "paint" },
        "*",
      );
    });
  });
}

test("paused timing keeps the document and matches fresh pictures at NTSC cuts, linked source-in/rate, titles, undo and redo", async ({
  page,
  request,
}, info) => {
  test.setTimeout(120000);
  const { project, edit, read } = await fixture(request, page);
  const original = await live(page);
  let previous = await token(page);
  await edit([
    { type: "setTiming", clipId: "v1", mediaStart: 1, playbackRate: 1.5 },
    // The speed edit ripples v2 to frame 51. Leave a one-frame gap before it.
    { type: "trim", clipId: "v1", edge: "end", to: 50, ripple: false },
    { type: "move", clipIds: ["title"], by: 1, mode: "overwrite" },
  ]);
  await waitForPreview(page, { after: previous });
  const picture = page.locator("iframe[data-live]").contentFrame();
  await expect(picture.locator("#v1")).toHaveAttribute("data-media-start", "1");
  await waitForPreview(page);
  expect(await live(page)).toBe(original);
  const clips = (await read()).timeline.clips;
  expect(clips.find((c) => c.id === "a1")?.mediaStart).toBe(1);
  expect(clips.find((c) => c.id === "a1")?.playbackRate).toBe(1.5);
  expect(clips.find((c) => c.id === "v1")?.duration).toBe(50);
  expect(clips.find((c) => c.id === "a1")?.duration).toBe(50);
  expect(clips.find((c) => c.id === "v2")?.start).toBe(51);
  expect(clips.find((c) => c.id === "a2")?.start).toBe(51);
  const control = await page.context().newPage();
  try {
    // The patched page never reloads. Every control picture starts in another fresh document.
    for (const step of ["Control+z", "Control+Shift+z"]) {
      previous = await token(page);
      await page.getByRole("button", { name: /^Current time/ }).focus();
      await page.keyboard.press(step);
      await waitForPreview(page, { after: previous });
      await expect(picture.locator("#v1")).toHaveAttribute(
        "data-media-start",
        step === "Control+z" ? "0" : "1",
      );
      await waitForPreview(page);
      expect(await live(page)).toBe(original);
      await control.goto(`/#project/${project.id}`);
      await waitForPreview(control);
      await seek(page, 0);
      await seek(control, 0);
      const patched = await page.locator(".edit-picture").screenshot();
      const fresh = await control.locator(".edit-picture").screenshot();
      await info.attach("history live.png", {
        body: patched,
        contentType: "image/png",
      });
      await info.attach("history fresh.png", {
        body: fresh,
        contentType: "image/png",
      });
      expect(patched.equals(fresh), step).toBe(true);
      expect(await corrections(page), step).toBe(0);
      // The reference is a fresh render, not a second editor applying the next history step.
      await control.goto("about:blank");
    }
    for (const frame of [0, 30, 31, 49, 50, 51, 52]) {
      await seek(page, frame);
      const patched = await page.locator(".edit-picture").screenshot();
      await control.goto(`/#project/${project.id}`);
      await waitForPreview(control);
      await seek(control, frame);
      const fresh = await control.locator(".edit-picture").screenshot();
      expect(patched.equals(fresh), `frame ${frame}`).toBe(true);
      expect(await corrections(page), `frame ${frame}`).toBe(0);
      expect(await live(page)).toBe(original);
      if (frame === 51)
        await info.attach("NTSC cut.png", {
          body: fresh,
          contentType: "image/png",
        });
      await control.goto("about:blank");
    }
  } finally {
    await control.close();
  }
});

/** How many videos the bridge had to move itself because the runtime left them elsewhere. */
const corrections = async (page: Page) =>
  Number(
    await page
      .locator("iframe[data-live]")
      .contentFrame()
      .locator("html")
      .getAttribute("data-cutroom-media-corrections"),
  );

/**
 * Each frame of the edited tab must equal the same frame of a freshly loaded document. Unless
 * a test makes a seek land late, neither tab's bridge may have moved a video: a wrong target
 * would otherwise pass here, since both tabs run the same bridge.
 */
async function matchesFresh(
  page: Page,
  projectId: string,
  frames: number[],
  label: string,
  { lateSeeks = false, priorCorrections = 0 } = {},
) {
  const control = await page.context().newPage();
  try {
    await control.goto(`/#project/${projectId}`);
    await waitForPreview(control);
    for (const frame of frames) {
      await seek(page, frame);
      await seek(control, frame);
      const patched = await page.locator(".edit-picture").screenshot();
      const fresh = await control.locator(".edit-picture").screenshot();
      if (!patched.equals(fresh)) {
        // Record what each preview held, so a rare mismatch on CI can be explained.
        const state = (tab: Page) =>
          tab
            .locator("iframe[data-live]")
            .contentFrame()
            .locator("main")
            .evaluate(() => ({
              time: (
                window as unknown as { __player?: { getTime(): number } }
              ).__player?.getTime(),
              videos: [...document.querySelectorAll("video")].map((video) => ({
                id: video.id,
                currentTime: video.currentTime,
                readyState: video.readyState,
                seeking: video.seeking,
                visibility: getComputedStyle(video).visibility,
                held: video.hasAttribute("data-cutroom-held"),
                style: video.getAttribute("style"),
              })),
              holds: [
                ...document.querySelectorAll(
                  "[data-cutroom-video-hold], [data-cutroom-edit-frame]",
                ),
              ].map((hold) => ({
                kind: hold.hasAttribute("data-cutroom-video-hold")
                  ? "hold"
                  : "edit frame",
                display: getComputedStyle(hold).display,
                visibility: getComputedStyle(hold).visibility,
              })),
            }));
        const name = `${label} frame ${frame}`.replace(/\W+/g, "-");
        await test.info().attach(`${name} patched.png`, {
          body: patched,
          contentType: "image/png",
        });
        await test.info().attach(`${name} fresh.png`, {
          body: fresh,
          contentType: "image/png",
        });
        console.log(
          "PICTURE MISMATCH",
          name,
          JSON.stringify({
            patched: await state(page),
            fresh: await state(control),
          }),
        );
      }
      expect(patched.equals(fresh), `${label}, frame ${frame}`).toBe(true);
      if (!lateSeeks)
        expect(await corrections(page), label).toBe(priorCorrections);
      expect(await corrections(control), label).toBe(0);
    }
  } finally {
    await control.close();
  }
}

test("a timing edit after the playhead crosses a cut keeps the document", async ({
  page,
  request,
}) => {
  const { project, edit } = await fixture(request, page);
  // The runtime swaps the visible clips once the new one has decoded, after the seek returns.
  await seek(page, 100);
  const original = await live(page);
  const previous = await token(page);
  await edit([{ type: "move", clipIds: ["title"], by: 1, mode: "overwrite" }]);
  await waitForPreview(page, { after: previous });
  await waitForPreview(page);
  expect(await live(page)).toBe(original);
  await matchesFresh(page, project.id, [31, 40, 100], "after a seek");
});

test("a video whose seek lands late as it comes back into view is not confirmed at its old frame", async ({
  page,
  request,
}) => {
  const { project } = await fixture(request, page);
  await seek(page, 100);
  // v1 is hidden here and still at its first frame. Make every seek the runtime gives it
  // land 1.5 s late, as a slow or reloaded video's can.
  await page
    .locator("iframe[data-live]")
    .contentFrame()
    .locator("#v1")
    .evaluate((video: HTMLVideoElement) => {
      const time = Object.getOwnPropertyDescriptor(
        HTMLMediaElement.prototype,
        "currentTime",
      )!;
      Object.defineProperty(video, "currentTime", {
        configurable: true,
        get: () => time.get!.call(video),
        set: (value: number) => {
          setTimeout(() => time.set!.call(video, value), 1500);
        },
      });
    });
  await matchesFresh(page, project.id, [31], "late seek", { lateSeeks: true });
  expect(await corrections(page)).toBeGreaterThan(0);
});

// Authored values Cutroom never writes, but an agent or another editor can. The runtime, and
// so export, reads them its own way; the bridge must agree and leave the video where it is.
for (const [name, attribute] of [
  ["a rate above the runtime's limit", 'data-playback-rate="12"'],
  ["a start with a unit", 'data-playback-start="0.5s"'],
  ["a negative start", 'data-playback-start="-1"'],
] as const)
  test(`a video with ${name} is drawn where the runtime alone draws it`, async ({
    page,
    request,
  }) => {
    test.setTimeout(90000);
    const { project } = await fixture(request, page);
    const path = join(project.path, "index.html");
    const previous = await token(page);
    await replaceIndex(
      project.path,
      (await readFile(path, "utf8")).replace('id="v2"', `id="v2" ${attribute}`),
    );
    await waitForPreview(page, { after: previous });
    await waitForPreview(page);
    await seek(page, 80);
    // The runtime alone: the same document, with its bridge unable to compute a target.
    const control = await page.context().newPage();
    try {
      await control.goto(`/#project/${project.id}`);
      await waitForPreview(control);
      await control
        .locator("iframe[data-live]")
        .contentFrame()
        .locator("html")
        .evaluate(() => {
          const hf = (window as unknown as { __hf: Record<string, unknown> })
            .__hf;
          delete hf.clipWindow;
        });
      await seek(control, 80);
      expect(
        (await page.locator(".edit-picture").screenshot()).equals(
          await control.locator(".edit-picture").screenshot(),
        ),
      ).toBe(true);
      expect(await corrections(page)).toBe(0);
    } finally {
      await control.close();
    }
  });

test("a video still off after one correction is accepted instead of waiting out the frame deadline", async ({
  page,
  request,
}) => {
  await fixture(request, page);
  await seek(page, 100);
  // Every read of a clip's window moves its target, so no seek can ever match it.
  await page
    .locator("iframe[data-live]")
    .contentFrame()
    .locator("html")
    .evaluate(() => {
      const hf = (
        window as unknown as {
          __hf: {
            clipWindow: (
              element: Element,
            ) => { start: number; end: number } | null;
          };
        }
      ).__hf;
      const original = hf.clipWindow.bind(hf);
      let shift = 0;
      hf.clipWindow = (element) => {
        const window = original(element);
        shift += 0.25;
        return window && { start: window.start - shift, end: Infinity };
      };
    });
  const started = Date.now();
  await seek(page, 31);
  expect(Date.now() - started).toBeLessThan(5000);
  // Once per video per picture: this seek refreshes the picture at most twice.
  expect(await corrections(page)).toBeGreaterThan(0);
  expect(await corrections(page)).toBeLessThanOrEqual(2);
});

/** The timeline meters' lit share, per bar, after playing from `frame` for a moment. */
async function meters(page: Page, frame: number) {
  await seek(page, frame);
  const play = page.getByRole("button", { name: "Play forward", exact: true });
  await play.click();
  await expect(play).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(800);
  const levels = await page
    .locator(".tl-meter-level")
    .evaluateAll((bars) =>
      bars.map(
        (bar) =>
          100 -
          Number.parseFloat(
            /inset\(([\d.]+)%/.exec(getComputedStyle(bar).clipPath)?.[1] ??
              "100",
          ),
      ),
    );
  await page.keyboard.press("Space");
  await expect(play).toHaveAttribute("aria-pressed", "false");
  return levels;
}

/** The clip parent's nodes, whitespace included, with adjacent text merged as a parser would. */
const clipNodes = (page: Page) =>
  page
    .locator("iframe[data-live]")
    .contentFrame()
    .locator("main")
    .evaluate((main) =>
      [...main.childNodes]
        .filter(
          (node) =>
            !(
              node instanceof Element &&
              node.matches(
                "[data-cutroom-video-hold], [data-cutroom-edit-frame]",
              )
            ),
        )
        .map((node) =>
          node instanceof Text ? node.data : `<${(node as Element).id}>`,
        )
        .reduce<string[]>((nodes, node) => {
          const last = nodes.at(-1);
          if (
            !node.startsWith("<") &&
            last !== undefined &&
            !last.startsWith("<")
          )
            nodes[nodes.length - 1] = last + node;
          else nodes.push(node);
          return nodes;
        }, []),
    );

test("an indented source keeps its whitespace exactly through lift, razor and undo in place", async ({
  page,
  request,
}) => {
  test.setTimeout(180000);
  const { project, edit } = await fixture(request, page, "", "", true);
  const original = await live(page);
  const matches = async (label: string, frames: number[]) => {
    await waitForPreview(page);
    expect(await live(page), label).toBe(original);
    await matchesFresh(page, project.id, frames, label);
    const control = await page.context().newPage();
    try {
      await control.goto(`/#project/${project.id}`);
      await waitForPreview(control);
      expect(await clipNodes(page), label).toEqual(await clipNodes(control));
    } finally {
      await control.close();
    }
  };
  const undo = async () => {
    const previous = await token(page);
    await page.getByRole("button", { name: /^Current time/ }).focus();
    await page.keyboard.press("Control+z");
    await waitForPreview(page, { after: previous });
  };
  await seek(page, 40);
  let previous = await token(page);
  await edit([{ type: "remove", clipIds: ["v1"], ripple: false }]);
  await waitForPreview(page, { after: previous });
  await matches("lift", [40, 76]);
  await undo();
  await matches("undo lift", [40, 76]);
  await seek(page, 150);
  previous = await token(page);
  await edit([{ type: "split", at: 150, clipIds: ["v2"] }]);
  await waitForPreview(page, { after: previous });
  await matches("razor", [149, 150]);
  await undo();
  await matches("undo razor", [150]);
});

test("a removed clip whose whitespace is not where the snapshot says reloads instead of guessing", async ({
  page,
  request,
}) => {
  const { project, edit } = await fixture(request, page, "", "", true);
  await seek(page, 40);
  const original = await live(page);
  // The live comparison leaves out the bridge's own canvases, so only the whitespace check
  // sees one between the removed clip and the whitespace it owns.
  await page
    .locator("iframe[data-live]")
    .contentFrame()
    .locator("#v1")
    .evaluate((video) => {
      const canvas = document.createElement("canvas");
      canvas.setAttribute("data-cutroom-edit-frame", "");
      video.before(canvas);
    });
  const previous = await token(page);
  await edit([{ type: "remove", clipIds: ["v1"], ripple: false }]);
  await waitForPreview(page, { after: previous });
  await waitForPreview(page);
  expect(await live(page)).not.toBe(original);
  const control = await page.context().newPage();
  try {
    await control.goto(`/#project/${project.id}`);
    await waitForPreview(control);
    expect(await clipNodes(page)).toEqual(await clipNodes(control));
  } finally {
    await control.close();
  }
});

// Adding a clip back can restyle the clips that stay as well.
test("an undo that starts an animation on another clip reloads and matches a fresh document", async ({
  page,
  request,
}) => {
  test.setTimeout(120000);
  const { project, edit } = await fixture(
    request,
    page,
    "",
    "main:has(#a1) #title{animation:slide 20s linear both}@keyframes slide{to{transform:translateX(400px)}}",
  );
  await seek(page, 40);
  const lifted = await live(page);
  let previous = await token(page);
  await edit([{ type: "remove", clipIds: ["v1"], ripple: false }]);
  await waitForPreview(page, { after: previous });
  await waitForPreview(page);
  expect(await live(page)).toBe(lifted);
  previous = await token(page);
  await page.getByRole("button", { name: /^Current time/ }).focus();
  await page.keyboard.press("Control+z");
  await waitForPreview(page, { after: previous });
  await waitForPreview(page);
  expect(await live(page)).not.toBe(lifted);
  await matchesFresh(page, project.id, [40, 60], "undo");
});

test("native ripple waits for a slow timing response and keeps the loaded preview", async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    if (window === window.top)
      localStorage.setItem("cutroom.footagePipeline", "false");
  });
  const { project, edit } = await fixture(request, page);
  await seek(page, 40);
  const original = await live(page);
  const previous = await token(page);
  const timing =
    /\/api\/projects\/[^/]+\/isolated-preview\?[^#]*\bcutroom-timing=1\b/;
  const delayed = Promise.withResolvers<void>();
  await page.route(
    timing,
    async (route) => {
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 2500));
      delayed.resolve();
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  await edit([{ type: "remove", clipIds: ["v1"], ripple: true }]);
  await delayed.promise;
  await waitForPreview(page, { after: previous });
  await expect(
    page.locator("iframe[data-live]").contentFrame().locator("#v1, #a1"),
  ).toHaveCount(0);
  expect(await live(page)).toBe(original);
  await matchesFresh(page, project.id, [40], "delayed native ripple");
});

test("ripple delete, lift, razor, turning clips off and every undo keep the document and match fresh pictures", async ({
  page,
  request,
}) => {
  test.setTimeout(240000);
  const { project, edit } = await fixture(request, page);
  const picture = page.locator("iframe[data-live]").contentFrame();
  let previous = await token(page);
  await edit([{ type: "setTrack", index: 1, volume: 0.5 }]);
  await waitForPreview(page, { after: previous });
  // A first gain away from unity gives the track's bus a render id, which needs a fresh document.
  await page.reload();
  await waitForPreview(page, { timing: true });
  await seek(page, 100);
  const original = await live(page);
  const inPlace = async (
    change: () => Promise<unknown>,
    frames: number[],
    label: string,
  ) => {
    const previous = await token(page);
    // A stop during the earlier meter run can legitimately correct its last
    // playback picture. Count new corrections from this edit onward.
    const priorCorrections = await corrections(page);
    await change();
    await waitForPreview(page, { after: previous });
    await waitForPreview(page);
    expect(await live(page), label).toBe(original);
    await matchesFresh(page, project.id, frames, label, { priorCorrections });
  };
  const undo = () => {
    return page
      .getByRole("button", { name: /^Current time/ })
      .focus()
      .then(() => page.keyboard.press("Control+z"));
  };
  // Removing the first pair closes the gap: the second pair and the title move back,
  // and the composition shortens.
  const length = await picture.locator("main").getAttribute("data-duration");
  await inPlace(
    () => edit([{ type: "remove", clipIds: ["v1"], ripple: true }]),
    [0, 43, 44, 100],
    "ripple delete",
  );
  await expect(picture.locator("#v1, #a1")).toHaveCount(0);
  await expect(picture.locator("main")).not.toHaveAttribute(
    "data-duration",
    length!,
  );
  await inPlace(undo, [0, 75, 76], "undo ripple delete");
  await expect(picture.locator("#v1, #a1")).toHaveCount(2);
  await seek(page, 40);
  await inPlace(
    () => edit([{ type: "remove", clipIds: ["v1"], ripple: false }]),
    [0, 40, 75, 76],
    "lift",
  );
  await inPlace(undo, [0, 40, 76], "undo lift");
  // The sound that came back plays through its track's gain, as in a fresh document.
  const patched = await meters(page, 10);
  const control = await page.context().newPage();
  try {
    await control.goto(`/#project/${project.id}`);
    await waitForPreview(control);
    const fresh = await meters(control, 10);
    expect(patched.length).toBeGreaterThan(0);
    expect(Math.max(...patched)).toBeGreaterThan(10);
    for (const [index, level] of patched.entries())
      expect(Math.abs(level - fresh[index]!), `meter ${index}`).toBeLessThan(5);
  } finally {
    await control.close();
  }
  // Playing in between does not cost the next edit its in-place update.
  await seek(page, 150);
  await inPlace(
    () => edit([{ type: "split", at: 150, clipIds: ["v2"] }]),
    [149, 150, 151],
    "razor",
  );
  await expect(picture.locator("video")).toHaveCount(3);
  await inPlace(undo, [149, 150], "undo razor");
  await seek(page, 30);
  await inPlace(
    () => edit([{ type: "setClip", clipId: "v1", enabled: false }]),
    [30],
    "clip off",
  );
  await inPlace(
    () => edit([{ type: "setClip", clipId: "v1", enabled: true }]),
    [30, 76],
    "clip on",
  );
});

test("the edit after a burst of W, undo, D and lift at 7 keys a second keeps the document and matches a fresh picture", async ({
  page,
  request,
}) => {
  test.setTimeout(180000);
  const project = await interviewWorkload(request);
  // Give the title stylesheet its stacking rules first, so no edit below changes it.
  for (const by of [1, -1]) {
    const view = TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    );
    const response = await request.post(
      `/api/cutroom/projects/${project.id}/commands`,
      {
        data: {
          composition: "index.html",
          expectedRevision: view.revision,
          label: "Establish stacking",
          commands: [
            { type: "move", clipIds: ["title-0"], by, mode: "overwrite" },
          ],
        },
      },
    );
    expect(response.ok()).toBe(true);
  }
  await page.goto(`/#project/${project.id}`);
  await waitForPreview(page, { timing: true });
  await seek(page, 90);
  const original = await live(page);
  let pressed = -Infinity;
  const press = async (key: string) => {
    const delay = pressed + 140 - performance.now();
    if (delay > 0) await page.waitForTimeout(delay);
    pressed = performance.now();
    await page.keyboard.press(key);
  };
  // W cuts the music bed too, adding its tail as a clip, and undo takes it away.
  await press("w");
  await press("Control+z");
  // A W pressed before the undo is saved would find nothing to trim, so the burst goes on
  // with Alt+D, which shows at once. Each Alt+D that turns the music bed on adds it back, before
  // the runtime's last layout pass is a third of a second old.
  await page.locator('[data-clip="music"]').click({ force: true });
  for (let index = 0; index < 12; index++) await press("Alt+d");
  await page.locator('[data-clip="broll-0"]').click({ force: true });
  await press("Backspace");
  await waitForPreview(page);
  // Let every write the burst started land before the next edit compares the document.
  await page.waitForTimeout(1000);
  const previous = await token(page);
  await page.keyboard.press("Control+z");
  await waitForPreview(page, { after: previous });
  await waitForPreview(page);
  expect(await live(page)).toBe(original);
  await matchesFresh(page, project.id, [89, 90, 240], "after the burst");
});

test("lifting a clip matches fresh pictures through a dissolve, a transform and track gain", async ({
  page,
  request,
}) => {
  test.setTimeout(150000);
  const { project, edit } = await fixture(request, page);
  let previous = await token(page);
  await edit([
    { type: "setClip", clipId: "v2", scale: 1.25, rotation: 5 },
    {
      type: "setTransition",
      from: "v1",
      to: "v2",
      transition: { kind: "dissolve", duration: 20, alignment: "center" },
    },
    { type: "setTrack", index: 1, volume: 0.5 },
  ]);
  await waitForPreview(page, { after: previous });
  await waitForPreview(page, { timing: true });
  // A second title keeps its track, and so the track stylesheet, after the lift. Its fade in
  // is an animation the runtime finds only when it loads, so adding it takes a fresh document.
  const before = await live(page);
  previous = await token(page);
  await edit([
    {
      type: "insert",
      track: 2,
      at: 200,
      clip: { kind: "title", id: "late", text: "Later", duration: 60 },
    },
  ]);
  await waitForPreview(page, { after: previous });
  await waitForPreview(page, { timing: true });
  expect(await live(page)).not.toBe(before);
  const original = await live(page);
  previous = await token(page);
  await edit([{ type: "remove", clipIds: ["title"], ripple: false }]);
  await waitForPreview(page, { after: previous });
  await waitForPreview(page);
  expect(await live(page)).toBe(original);
  await matchesFresh(page, project.id, [60, 70, 76, 80, 86, 150], "lift");
});

// Authored rules that depend on which clips are present restyle the clips that stay.
for (const [kind, css] of [
  [
    "an animation",
    "main:not(:has(#a1)) #title{animation:slide 20s linear both}@keyframes slide{to{transform:translateX(400px)}}",
  ],
  [
    "a transition",
    "#title{transition:transform 6s linear}main:not(:has(#a1)) #title{transform:translateX(300px)}",
  ],
] as const)
  test(`a lift that starts ${kind} on another clip reloads and matches a fresh document`, async ({
    page,
    request,
  }) => {
    test.setTimeout(120000);
    const { project, edit } = await fixture(request, page, "", css);
    await seek(page, 40);
    const original = await live(page);
    const previous = await token(page);
    await edit([{ type: "remove", clipIds: ["v1"], ripple: false }]);
    await waitForPreview(page, { after: previous });
    await waitForPreview(page);
    // The runtime discovers CSS animations and transitions only when a document loads.
    expect(await live(page)).not.toBe(original);
    await matchesFresh(page, project.id, [40, 60], kind);
  });

test("MCP and disk edits refresh both tabs in place, while script and CSS changes reload", async ({
  page,
  request,
  baseURL,
}) => {
  test.setTimeout(120000);
  const { project, read } = await fixture(request, page);
  const second = await page.context().newPage();
  await second.goto(`/#project/${project.id}`);
  await waitForPreview(second);
  await waitForPreview(second, { timing: true });
  const docs = await Promise.all([live(page), live(second)]);
  const tokens = await Promise.all([token(page), token(second)]);
  const client = new Client({ name: "timing-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
      requestInit: { headers: { origin: baseURL! } },
    }),
  );
  try {
    const view = await read();
    const result = await client.callTool({
      name: "timeline_edit",
      arguments: {
        projectId: project.id,
        composition: "index.html",
        expectedRevision: view.revision,
        label: "Agent source in",
        commands: [{ type: "setTiming", clipId: "v1", mediaStart: 1 }],
      },
    });
    expect(result.isError).not.toBe(true);
  } finally {
    await client.close();
  }
  await Promise.all([
    waitForPreview(page, { after: tokens[0]! }),
    waitForPreview(second, { after: tokens[1]! }),
  ]);
  for (const tab of [page, second])
    await expect(
      tab.locator("iframe[data-live]").contentFrame().locator("#v1"),
    ).toHaveAttribute("data-media-start", "1");
  await Promise.all([waitForPreview(page), waitForPreview(second)]);
  expect(await Promise.all([live(page), live(second)])).toEqual(docs);
  let source = await readFile(join(project.path, "index.html"), "utf8");
  const diskTokens = await Promise.all([token(page), token(second)]);
  source = source.replace('data-media-start="1"', 'data-media-start="2"');
  await replaceIndex(project.path, source);
  await Promise.all([
    waitForPreview(page, { after: diskTokens[0]! }),
    waitForPreview(second, { after: diskTokens[1]! }),
  ]);
  for (const tab of [page, second])
    await expect(
      tab.locator("iframe[data-live]").contentFrame().locator("#v1"),
    ).toHaveAttribute("data-media-start", "2");
  let previous = await token(page);
  // New words on a clip replace it in place.
  const wordsDoc = await live(page);
  source = source.replace("Chapter one", "Chapter two");
  await writeFile(join(project.path, "index.html"), source);
  await waitForPreview(page, { after: previous });
  await expect(
    page.locator("iframe[data-live]").contentFrame().locator("#title"),
  ).toHaveText("Chapter two");
  expect(await live(page)).toBe(wordsDoc);
  for (const transform of [
    (s: string) => s.replace("color:white", "color:yellow"),
    (s: string) =>
      s.replace("</body>", "<script>window.testValue=42</script></body>"),
    (s: string) => s.replace('id="title"', 'id="title" data-track-index="3"'),
    (s: string) =>
      s.replace(
        "</main>",
        '<div class="clip" id="new" data-start="0" data-duration="1">New</div></main>',
      ),
    (s: string) => s.replace(/<div class="clip" id="new".*?<\/div>/, ""),
  ]) {
    const oldDoc = await live(page);
    previous = await token(page);
    source = transform(source);
    await writeFile(join(project.path, "index.html"), source);
    await waitForPreview(page, { after: previous });
    expect(await live(page)).not.toBe(oldDoc);
  }
  await second.close();
});

test("rapid edits and missing, failed or late acknowledgments fall back without accepting stale pictures", async ({
  page,
  request,
}) => {
  test.setTimeout(120000);
  await page.addInitScript(() => {
    addEventListener(
      "message",
      (event) => {
        const failure = document.documentElement?.dataset.failTiming;
        if (!failure || event.data?.action !== "timing") return;
        event.stopImmediatePropagation();
        console.debug(`timing fault: ${failure}`);
        if (failure === "missing") return;
        setTimeout(
          () =>
            parent.postMessage(
              {
                source: "cutroom-preview",
                id: event.data.id,
                state: {
                  ready: true,
                  root: true,
                  error: null,
                  width: 640,
                  height: 360,
                  fps: "30000/1001",
                  time: 0,
                  playing: false,
                },
                error: failure === "error" ? "injected failure" : undefined,
                timingRevision: event.data.timing.revision,
              },
              "*",
            ),
          failure === "late" ? 2500 : 0,
        );
      },
      true,
    );
  });
  const { edit } = await fixture(request, page);
  const previous = await token(page);
  await page.locator('[data-clip="title"]').click({ force: true });
  // Native inputs go through the editor's queue even when a picture is still pending.
  const started = performance.now();
  for (let index = 0; index < 8; index++) {
    const delay = started + index * 125 - performance.now();
    if (delay > 0) await page.waitForTimeout(delay);
    const field = page.getByLabel("Start", { exact: true });
    await field.focus();
    await field.press("ArrowUp");
    await field.press("Enter");
  }
  await waitForPreview(page, { after: previous });
  await waitForPreview(page);
  await expect
    .poll(async () =>
      page
        .frames()
        .find((f) => f.url().includes("/api/isolated/"))
        ?.evaluate(() =>
          document.querySelector("#title")?.getAttribute("data-start"),
        ),
    )
    .toBe(String((38 * 1001) / 30000));
  await waitForPreview(page);
  for (const failure of ["missing", "late", "error"] as const) {
    await waitForPreview(page, { timing: true });
    const intercepted = page.waitForEvent("console", {
      predicate: (message) => message.text() === `timing fault: ${failure}`,
    });
    const doc = await live(page),
      before = await token(page);
    // Alter only the next live document's bridge, never its replacement.
    const frame = (await (await page
      .locator("iframe[data-live]")
      .elementHandle())!.contentFrame())!;
    await frame.evaluate((failure) => {
      document.documentElement.dataset.failTiming = failure;
    }, failure);
    await edit([
      { type: "move", clipIds: ["title"], by: 1, mode: "overwrite" },
    ]);
    await intercepted;
    await waitForPreview(page, { after: before });
    await expect.poll(() => live(page)).not.toBe(doc);
    await page.waitForTimeout(600);
    expect(await live(page)).not.toBe(doc);
  }
});

test("a source race retires an in-flight timing snapshot, and playing edits use the reload path", async ({
  page,
  request,
}) => {
  const { project, edit } = await fixture(request, page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  await page.route("**/isolated-preview?*cutroom-timing*", async (route) => {
    const response = await route.fetch();
    entered();
    await held;
    await route.fulfill({ response }).catch(() => {});
  });
  const previous = await token(page),
    doc = await live(page);
  await edit([{ type: "move", clipIds: ["title"], by: 1, mode: "overwrite" }]);
  await waiting;
  const path = join(project.path, "index.html");
  await writeFile(
    path,
    (await readFile(path, "utf8")).replace(
      "Chapter one",
      "Outside replacement",
    ),
  );
  await expect.poll(() => live(page)).not.toBe(doc);
  release();
  await waitForPreview(page, { after: previous });
  const current = (await (await page
    .locator("iframe[data-live]")
    .elementHandle())!.contentFrame())!;
  await expect(current.locator("#title")).toHaveText("Outside replacement");
  await page.unroute("**/isolated-preview?*cutroom-timing*");
  const playingDoc = await live(page),
    playingToken = await token(page);
  await page.getByRole("button", { name: "Play forward", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Play forward", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await edit([{ type: "move", clipIds: ["title"], by: 1, mode: "overwrite" }]);
  await waitForPreview(page, { after: playingToken });
  expect(await live(page)).not.toBe(playingDoc);
  await page.keyboard.press("Space");
});

test("a refused save never changes the preview document or its picture", async ({
  page,
  request,
}) => {
  await fixture(request, page);
  await seek(page, 45);
  await page.locator('[data-clip="title"]').click({ force: true });
  const original = await live(page);
  const picture = await page.locator(".edit-picture").screenshot();
  await page.route("**/api/cutroom/projects/*/commands", (route) =>
    route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({
        error: "Refused timing save",
        code: "unsupported",
      }),
    }),
  );
  await page.locator('[data-clip="title"]').click({ force: true });
  const start = page.getByLabel("Start", { exact: true });
  await start.focus();
  await start.press("ArrowUp");
  await start.press("Enter");
  await expect(
    page.getByText("Refused timing save", { exact: true }),
  ).toBeVisible();
  expect(await live(page)).toBe(original);
  expect(picture.equals(await page.locator(".edit-picture").screenshot())).toBe(
    true,
  );
});

for (const [name, scripts] of [
  [
    "init-time GSAP",
    '<script src="assets/vendor/gsap.min.js"></script><script>const title=document.querySelector("#title");window.__timelines={main:gsap.timeline({paused:true}).fromTo(title,{x:-120},{x:0,duration:1},+title.dataset.start)};</script>',
  ],
  ["noembed", "<noembed><script>window.authored=true</script></noembed>"],
  ["noscript", "<noscript><script>window.authored=true</script></noscript>"],
  [
    "forged timing replies",
    '<script>addEventListener("message",e=>{if(e.data?.action!=="timing")return;parent.postMessage({type:"forged-timing-attempt"},"*");parent.postMessage({source:"cutroom-preview",id:e.data.id,timingRevision:e.data.timing.revision,state:{ready:true,root:true,error:null,width:640,height:360,fps:"30000/1001",time:0,playing:false}},"*")})</script>',
  ],
] as const)
  test(`authored ${name} always reloads, even if the next source becomes script-free`, async ({
    page,
    request,
  }) => {
    await page.addInitScript(() => {
      Reflect.set(window, "forgedTimingAttempts", 0);
      addEventListener("message", (e) => {
        if (e.data?.type === "forged-timing-attempt")
          Reflect.set(
            window,
            "forgedTimingAttempts",
            Number(Reflect.get(window, "forgedTimingAttempts")) + 1,
          );
      });
    });
    let snapshots = 0;
    page.on("request", (request) => {
      if (request.url().includes("cutroom-timing=")) snapshots++;
    });
    const { project, edit } = await fixture(request, page, scripts);
    for (const commands of [
      [{ type: "move", clipIds: ["title"], by: 1, mode: "overwrite" }],
      [{ type: "remove", clipIds: ["v1"], ripple: true }],
      [{ type: "split", at: 150, clipIds: ["v2"] }],
    ] satisfies CommandInput[][]) {
      const doc = await live(page),
        before = await token(page);
      await edit(commands);
      await waitForPreview(page, { after: before });
      expect(await live(page)).not.toBe(doc);
    }
    expect(snapshots).toBe(0);
    if (name === "init-time GSAP") {
      const control = await page.context().newPage();
      try {
        await control.goto(`/#project/${project.id}`);
        await waitForPreview(control);
        await seek(page, 45);
        await seek(control, 45);
        expect(
          (await page.locator(".edit-picture").screenshot()).equals(
            await control.locator(".edit-picture").screenshot(),
          ),
        ).toBe(true);
      } finally {
        await control.close();
      }
    }
    const scripted = await live(page),
      prior = await token(page);
    const path = join(project.path, "index.html");
    await writeFile(path, (await readFile(path, "utf8")).replace(scripts, ""));
    await waitForPreview(page, { after: prior });
    expect(await live(page)).not.toBe(scripted);
    expect(
      await page.evaluate(() => Reflect.get(window, "forgedTimingAttempts")),
    ).toBe(0);
  });

for (const [divergence, change] of [
  ["text", "timing"],
  ["style", "timing"],
  ["element", "timing"],
  ["element", "removal"],
] as const)
  test(`a script-free document with divergent live ${divergence} fails closed on a ${change} edit`, async ({
    page,
    request,
  }) => {
    const { edit } = await fixture(request, page);
    const before = await token(page),
      doc = await live(page);
    const frame = (await (await page
      .locator("iframe[data-live]")
      .elementHandle())!.contentFrame())!;
    await frame.evaluate((divergence) => {
      const title = document.querySelector<HTMLElement>("#title")!;
      if (divergence === "text") title.textContent = "Divergent";
      if (divergence === "style") title.style.background = "red";
      if (divergence === "element")
        title.append(document.createElement("span"));
    }, divergence);
    await edit(
      change === "timing"
        ? [{ type: "move", clipIds: ["title"], by: 1, mode: "overwrite" }]
        : [{ type: "remove", clipIds: ["v1"], ripple: true }],
    );
    await waitForPreview(page, { after: before });
    expect(await live(page)).not.toBe(doc);
    const current = (await (await page
      .locator("iframe[data-live]")
      .elementHandle())!.contentFrame())!;
    await expect(current.locator("#title")).toHaveText("Chapter one");
  });

for (const scripted of [false, true])
  test(`${scripted ? "scripted bursts replace candidates" : "eligible bursts keep one active and latest pending refresh"} while preserving every save and undo step`, async ({
    page,
    request,
  }) => {
    test.setTimeout(120000);
    let timingWork = 0;
    page.on("request", (request) => {
      if (/cutroom-(status|timing)=/.test(request.url())) timingWork++;
    });
    const { read, project } = await fixture(
      request,
      page,
      scripted ? "<script>window.authored=true</script>" : "",
    );
    const initial = (await read()).timeline.clips.find(
      (clip) => clip.id === "title",
    )!.start;
    let navigations = 0;
    const captured = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await page.route("**/isolated-preview?*", async (route) => {
      if (!route.request().isNavigationRequest()) return route.continue();
      navigations++;
      if (navigations !== 1) return route.continue();
      captured.resolve();
      await release.promise;
      await route.continue().catch(() => {});
    });
    // Hold a real browser navigation until all saves finish, preserving its
    // navigation-bound authorization instead of replacing it with an API fetch.
    const source = join(project.path, "index.html");
    await replaceIndex(
      project.path,
      (await readFile(source, "utf8")).replace("color:white", "color:yellow"),
    );
    await captured.promise;
    let saves = 0;
    page.on("response", (response) => {
      if (response.url().endsWith("/commands") && response.ok()) saves++;
    });
    await page.locator('[data-clip="title"]').click({ force: true });
    try {
      const started = performance.now();
      for (let index = 0; index < 8; index++) {
        const delay = started + index * 125 - performance.now();
        if (delay > 0) await page.waitForTimeout(delay);
        const field = page.getByLabel("Start", { exact: true });
        await field.focus();
        await field.press("ArrowUp");
        await field.press("Enter");
        expect(
          await page.locator(".edit-picture iframe").count(),
        ).toBeLessThanOrEqual(2);
      }
      await expect.poll(() => saves).toBe(8);
      if (scripted) expect(navigations).toBeGreaterThan(1);
      else expect(navigations).toBe(1);
    } finally {
      release.resolve();
    }
    await expect
      .poll(async () =>
        page
          .locator("iframe[data-live]")
          .contentFrame()
          .locator("#title")
          .getAttribute("data-start"),
      )
      .toBe(String(((initial + 8) * 1001) / 30000));
    await waitForPreview(page);
    if (!scripted) expect(navigations).toBeLessThanOrEqual(2);
    // Preview coalescing must never coalesce saved history.
    for (let index = 0; index < 8; index++) {
      await page.getByRole("region", { name: "Viewer", exact: true }).click();
      await page.keyboard.press("Control+z");
      await expect
        .poll(
          async () =>
            (await read()).timeline.clips.find((clip) => clip.id === "title")!
              .start,
        )
        .toBe(initial + 7 - index);
    }
    await expect
      .poll(async () =>
        Number(
          await page
            .locator("iframe[data-live]")
            .contentFrame()
            .locator("#title")
            .getAttribute("data-start"),
        ),
      )
      .toBeCloseTo((initial * 1001) / 30000, 6);
    await waitForPreview(page);
    if (scripted) expect(timingWork).toBe(0);
  });

test("an unavailable fingerprint keeps the canonical full preview usable and ineligible for live timing", async ({
  page,
  request,
}) => {
  test.skip(
    process.platform === "win32" || process.getuid?.() === 0,
    "Needs directory permission boundaries",
  );
  const { project } = await fixture(request, page);
  const aux = join(project.path, "aux");
  await mkdir(aux);
  await writeFile(join(aux, "unused.tmp"), "temporary");
  await chmod(aux, 0o400);
  try {
    await page.reload();
    await waitForPreview(page);
    await seek(page, 45);
    const frame = page.locator("iframe[data-live]").contentFrame();
    await expect(frame.locator("#title")).toBeVisible();
    const response = await request.get(`${await live(page)}&cutroom-status=1`);
    expect(response.ok()).toBe(true);
    expect(await response.json()).toEqual({ allowed: false });
  } finally {
    await chmod(aux, 0o700);
  }
});

for (const scenario of ["playing", "forged hint"] as const)
  test(`${scenario} reloads replace superseded candidates without live timing`, async ({
    page,
    request,
  }) => {
    const scripted = scenario !== "playing";
    if (scenario === "forged hint")
      await page.addInitScript(() => {
        Reflect.set(window, "eligibilityAttempts", 0);
        addEventListener("message", (event) => {
          if (event.data?.type === "eligibility-attempt")
            Reflect.set(
              window,
              "eligibilityAttempts",
              Number(Reflect.get(window, "eligibilityAttempts")) + 1,
            );
        });
      });
    let timingRequests = 0;
    page.on("request", (request) => {
      if (request.url().includes("cutroom-timing=")) timingRequests++;
    });
    const { read } = await fixture(
      request,
      page,
      scenario === "forged hint"
        ? '<script>addEventListener("message",e=>{if(e.data?.source!=="cutroom-viewer"||e.data.action!=="inspect")return;parent.postMessage({type:"eligibility-attempt"},"*");parent.postMessage({source:"cutroom-preview",id:e.data.id,timingRevision:"forged",state:{ready:true,root:true,error:null,width:640,height:360,fps:"30000/1001",time:0,playing:false}},"*")})</script>'
        : scripted
          ? '<meta name="cutroom-timing-contract" content="attributes"><script>window.authored=true</script>'
          : "",
    );
    const first = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let navigations = 0;
    await page.route("**/isolated-preview?*", async (route) => {
      if (!route.request().isNavigationRequest()) return route.continue();
      if (++navigations !== 1) return route.continue();
      first.resolve();
      await release.promise;
      await route.continue().catch(() => {});
    });
    const initial = (await read()).timeline.clips.find(
      (clip) => clip.id === "title",
    )!.start;
    await page.locator('[data-clip="title"]').click({ force: true });
    if (!scripted)
      await page
        .getByRole("button", { name: "Play forward", exact: true })
        .click();
    const field = page.getByLabel("Start", { exact: true });
    await field.focus();
    await field.press("ArrowUp");
    await field.press("Enter");
    try {
      await first.promise;
      await field.press("ArrowUp");
      await field.press("Enter");
      // Main's path can finish the second revision while the first remains blocked.
      await expect.poll(() => navigations).toBeGreaterThanOrEqual(2);
      if (!scripted)
        await page.getByRole("button", { name: "Stop", exact: true }).click();
      await expect
        .poll(async () =>
          Number(
            await page
              .locator("iframe[data-live]")
              .contentFrame()
              .locator("#title")
              .getAttribute("data-start"),
          ),
        )
        .toBeCloseTo(((initial + 2) * 1001) / 30000, 6);
      await waitForPreview(page);
    } finally {
      release.resolve();
    }
    expect(timingRequests).toBe(0);
    if (scenario === "forged hint")
      expect(
        await page.evaluate(() => Reflect.get(window, "eligibilityAttempts")),
      ).toBeGreaterThan(0);
  });
