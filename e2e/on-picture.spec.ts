import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  createPositionProject,
  positionField,
  seekFrame,
  waitFrames,
} from "./position-helpers";

/**
 * A 640 x 360 frame: Badge is drawn over Title over Shot, Words is text in a box that is mostly
 * empty, Slide moves 300 px right between frames 30 and 90, and Lower has markup in its text.
 */
const composition = `<!doctype html><html><head><style>
html,body{margin:0;background:#142039}
main{position:relative;width:640px;height:360px;overflow:hidden}
.clip{position:absolute}
#shot{inset:0;background:#24406b}
#title{left:60px;top:100px;width:200px;height:50px;background:#d9482b;color:#fff;font:24px/50px sans-serif}
#badge{left:200px;top:110px;width:80px;height:30px;background:#3bd16f}
#words{left:340px;top:200px;width:240px;height:100px;color:#fff;font:20px/24px sans-serif}
#slide{left:20px;top:300px;width:60px;height:30px;background:#f2c94c}
#lower{left:60px;top:20px;color:#fff;font:18px/24px sans-serif}
</style><script src="gsap.min.js"></script></head><body>
<main id="main" data-composition-id="main" data-width="640" data-height="360" data-fps="30" data-duration="4">
<div id="shot" class="clip" data-start="0" data-duration="4" data-track-index="0" data-label="Shot"></div>
<div id="title" class="clip" data-start="0" data-duration="4" data-track-index="1" data-label="Title">Launch day</div>
<div id="badge" class="clip" data-start="0" data-duration="4" data-track-index="2" data-label="Badge"></div>
<div id="words" class="clip" data-start="0" data-duration="4" data-track-index="3" data-label="Words">Small words</div>
<div id="slide" class="clip" data-start="0" data-duration="4" data-track-index="4" data-label="Slide"></div>
<div id="lower" class="clip" data-start="0" data-duration="4" data-track-index="5" data-label="Lower"><b>Ada Park</b> <span>Editor</span></div>
</main>
<script>window.__timelines.main=gsap.timeline({paused:true}).to('#slide',{x:300,duration:2,ease:'none'},1);</script>
</body></html>`;

async function open(
  page: Page,
  request: APIRequestContext,
  html = composition,
) {
  const project = await createPositionProject(
    request,
    { name: "On picture", width: 640, height: 360, duration: 4 },
    html,
  );
  await copyFile(
    join(process.cwd(), "node_modules/gsap/dist/gsap.min.js"),
    join(project.path, "gsap.min.js"),
  );
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
  const box = await page.locator(".edit-picture").boundingBox();
  if (!box) throw new Error("Picture missing");
  const scale = box.width / 640;
  const commands: string[] = [];
  page.on("request", (sent) => {
    if (sent.method() === "POST" && sent.url().endsWith("/commands"))
      commands.push(sent.postData()!);
  });
  return {
    project,
    scale,
    commands,
    /** A composition pixel, in page coordinates. */
    at: (x: number, y: number) =>
      [box.x + x * scale, box.y + y * scale] as const,
    selected: page
      .getByRole("complementary", { name: "Inspector" })
      .locator(".inspector-clip strong"),
    /** Where the preview draws a clip, in composition pixels. */
    drawn: (id: string) =>
      page
        .frameLocator("iframe[data-live]")
        .locator(`#${id}`)
        .evaluate((element) => {
          const { left, top, width, height } = element.getBoundingClientRect();
          return { left, top, width, height };
        }),
    /** The outline's box, back in composition pixels. */
    outlined: async () => {
      const edges = page.locator(".edit-select-outline i");
      const [top, left] = await Promise.all([
        edges.nth(4).boundingBox(),
        edges.nth(6).boundingBox(),
      ]);
      if (!top || !left) return null;
      // The line hugs the box from one screen pixel outside it.
      return {
        left: (top.x + 1 - box.x) / scale,
        top: (top.y + 1 - box.y) / scale,
        width: (top.width - 2) / scale,
        height: (left.height - 2) / scale,
      };
    },
  };
}

/** The outline lands on whole screen pixels, so it may sit a pixel off the scaled box. */
const near = (
  actual: Record<string, number> | null,
  expected: Record<string, number>,
  scale: number,
) => {
  if (!actual) throw new Error("No outline");
  for (const [key, value] of Object.entries(expected))
    expect(Math.abs(actual[key]! - value), key).toBeLessThanOrEqual(1 / scale);
};

test("a click on the picture selects the topmost clip drawn there and leaves the note tools alone", async ({
  page,
  request,
}) => {
  const { at, selected } = await open(page, request);
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const outline = page.locator(".edit-select-outline");
  await expect(outline).toBeHidden();

  await page.mouse.click(...at(240, 125));
  await expect(selected).toHaveText("Badge");
  await expect(outline).toHaveAttribute("data-outlined", "badge");
  await expect(page.locator('[data-clip="badge"]')).toHaveClass(/selected/);

  // Alt steps down through what is drawn under the pointer, then wraps.
  for (const name of ["Title", "Shot", "Badge"]) {
    await page.keyboard.down("Alt");
    await page.mouse.click(...at(240, 125));
    await page.keyboard.up("Alt");
    await expect(selected).toHaveText(name);
  }

  // Words is text in a mostly empty box: its glyphs pick it, the empty part picks Shot behind.
  await page.mouse.click(...at(500, 280));
  await expect(selected).toHaveText("Shot");
  await page.mouse.click(...at(360, 212));
  await expect(selected).toHaveText("Words");
  // Once selected, its whole box is its own.
  await page.mouse.click(...at(500, 280));
  await expect(selected).toHaveText("Words");

  // Comment owns the picture while armed: the press pins a note and the selection stays.
  const tools = page.getByRole("toolbar", { name: "Tools" });
  await tools.getByRole("button", { name: /^Comment/ }).click();
  await page.mouse.click(...at(240, 125));
  await expect(page.getByRole("form", { name: "Note 1" })).toBeVisible();
  await expect(selected).toHaveText("Words");
  await page.keyboard.press("Escape");
  await tools.getByRole("button", { name: /^Select/ }).click();

  // The transport still takes its own clicks, and the stage around the picture selects nothing.
  await page.getByRole("button", { name: "Play forward", exact: true }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(selected).toHaveText("Words");
  const stage = await page.locator(".edit-stage").boundingBox();
  await page.mouse.click(stage!.x + 6, stage!.y + 6);
  await expect(inspector).toContainText("Select a clip to inspect it.");
  await expect(outline).toBeHidden();
});

test("the outline follows the selected clip through seeks and playback", async ({
  page,
  request,
}) => {
  const { at, scale, selected, drawn, outlined } = await open(page, request);
  await page.mouse.click(...at(50, 315));
  await expect(selected).toHaveText("Slide");
  near(await outlined(), { left: 20, top: 300, width: 60, height: 30 }, scale);

  await seekFrame(page, 60);
  expect((await drawn("slide")).left).toBeCloseTo(170, 0);
  await expect
    .poll(async () => (await outlined())?.left)
    .toBeGreaterThan(170 - 1 / scale);
  near(await outlined(), { left: 170, top: 300, width: 60 }, scale);

  await seekFrame(page, 30);
  await page.getByRole("button", { name: "Play forward", exact: true }).click();
  // Mid-move, the outline is wherever the clip is, not where it was parked.
  await expect.poll(async () => (await outlined())?.left).toBeGreaterThan(60);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
  await waitFrames(page);
  near(await outlined(), await drawn("slide"), scale);
});

test("the cached outline follows ancestor CSS motion and text resizing", async ({
  page,
  request,
}, info) => {
  const html = composition.replace(
    "</style>",
    `
    @keyframes move-frame { to { transform: translateX(140px) } }
    .moving { animation: move-frame 2s .2s linear forwards }
    </style>`,
  );
  const { at, selected, drawn, outlined, scale } = await open(
    page,
    request,
    html,
  );
  await page.mouse.click(...at(75, 30));
  await expect(selected).toHaveText("Lower");
  const preview = page.frameLocator("iframe[data-live]");
  await preview
    .locator("#main")
    .evaluate((element) => element.classList.add("moving"));
  await expect.poll(async () => (await outlined())?.left).toBeGreaterThan(100);
  const moving = await drawn("lower");
  expect(moving.left).toBeLessThan(190);
  expect(Math.abs((await outlined())!.left - moving.left)).toBeLessThan(5);
  await expect.poll(async () => (await drawn("lower")).left).toBe(200);
  await waitFrames(page, 3);
  near(await outlined(), await drawn("lower"), scale);
  const before = await drawn("lower");
  await preview.locator("#lower").evaluate((element) => {
    element.textContent = "A much longer replacement title";
  });
  await expect
    .poll(async () => (await outlined())?.width)
    .toBeGreaterThan(before.width + 50);
  near(await outlined(), await drawn("lower"), scale);
  await page.screenshot({ path: info.outputPath("cached-outline.png") });
});

test("dragging on the picture moves Position live, commits one undo step, and Escape restores", async ({
  page,
  request,
}) => {
  const { at, scale, commands, selected, drawn, outlined } = await open(
    page,
    request,
  );
  const x = positionField(page, "Position X");
  const y = positionField(page, "Position Y");
  const guide = page.locator('.edit-select-guides i[data-axis="x"]');

  // One press selects Words by its glyphs and drags it.
  await page.mouse.move(...at(360, 212));
  await page.mouse.down();
  await page.mouse.move(...at(380, 222), { steps: 4 });
  await page.mouse.move(...at(400, 242), { steps: 4 });
  await expect(selected).toHaveText("Words");
  await expect.poll(async () => (await drawn("words")).left).toBe(380);
  expect((await drawn("words")).top).toBe(230);
  near(await outlined(), { left: 380, top: 230 }, scale);
  // The inspector reads the move while it is still only a draft in the preview.
  await expect(x).toHaveValue("40 px");
  await expect(y).toHaveValue("30 px");
  expect(commands).toHaveLength(0);
  await page.mouse.up();
  await expect(x).toHaveValue("40 px");
  await expect(y).toHaveValue("30 px");
  await expect.poll(() => commands.length).toBe(1);
  expect(JSON.parse(commands[0]!).commands).toEqual([
    { type: "setClip", clipId: "words", x: 40, y: 30 },
  ]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(x).toHaveValue("0 px");
  await expect(y).toHaveValue("0 px");
  await expect.poll(async () => (await drawn("words")).left).toBe(340);

  // Escape puts the picture back and sends nothing.
  await page.mouse.move(...at(360, 212));
  await page.mouse.down();
  await page.mouse.move(...at(420, 260), { steps: 4 });
  await expect.poll(async () => (await drawn("words")).left).toBe(400);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect.poll(async () => (await drawn("words")).left).toBe(340);
  await expect(selected).toHaveText("Words");
  expect(commands).toHaveLength(1);

  // Shift keeps the larger direction only.
  await page.mouse.move(...at(360, 212));
  await page.mouse.down();
  await page.keyboard.down("Shift");
  await page.mouse.move(...at(390, 224), { steps: 4 });
  await expect.poll(async () => (await drawn("words")).left).toBe(370);
  expect((await drawn("words")).top).toBe(200);
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(x).toHaveValue("30 px");
  await expect(y).toHaveValue("0 px");

  // Title's centre is at 160; two pixels short of the frame's centre it snaps there.
  await page.mouse.click(...at(100, 125));
  await expect(selected).toHaveText("Title");
  await page.mouse.move(...at(100, 125));
  await page.mouse.down();
  await page.mouse.move(...at(258, 125), { steps: 6 });
  await expect(guide).toBeVisible();
  await expect.poll(async () => (await drawn("title")).left).toBe(220);
  // Ctrl lets go of the snap without moving the pointer.
  await page.keyboard.down("Control");
  await expect(guide).toBeHidden();
  await expect.poll(async () => (await drawn("title")).left).toBe(218);
  await page.keyboard.up("Control");
  await expect.poll(async () => (await drawn("title")).left).toBe(220);
  await page.mouse.up();
  await expect(guide).toBeHidden();
  await expect(x).toHaveValue("160 px");
});

test("arrow keys nudge the selected clip while the picture has focus", async ({
  page,
  request,
}) => {
  const { at, commands, selected, drawn } = await open(page, request);
  const x = positionField(page, "Position X");
  const y = positionField(page, "Position Y");
  const time = page.getByRole("button", {
    name: "Current time. Click to type a time.",
    exact: true,
  });
  const handle = page.locator(".edit-select-outline b").first();
  await page.mouse.click(...at(100, 125));
  await expect(selected).toHaveText("Title");

  // A click that only selects leaves the arrows with the playhead.
  await expect(handle).toBeHidden();
  await page.keyboard.press("ArrowRight");
  await expect(time).toHaveText("00:00:00:01");
  await page.keyboard.press("Home");
  await expect(time).toHaveText("00:00:00:00");
  expect(commands).toHaveLength(0);

  // Grabbing the selected clip shows its handles and hands it the arrows.
  await page.mouse.click(...at(100, 125));
  await expect(handle).toBeVisible();

  // A held key is one move and one undo step.
  await page.keyboard.down("ArrowRight");
  await page.keyboard.down("ArrowRight");
  await page.keyboard.down("ArrowRight");
  await expect.poll(async () => (await drawn("title")).left).toBe(63);
  expect(commands).toHaveLength(0);
  await page.keyboard.up("ArrowRight");
  await expect(x).toHaveValue("3 px");
  await expect.poll(() => commands.length).toBe(1);
  await page.keyboard.press("Shift+ArrowDown");
  await expect(y).toHaveValue("10 px");
  await expect.poll(() => commands.length).toBe(2);
  await expect(time).toHaveText("00:00:00:00");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(x).toHaveValue("0 px");
  await expect(y).toHaveValue("0 px");

  // A drag is a grab too, and a press in the timeline gives the arrows back to the playhead.
  await page.mouse.move(...at(100, 125));
  await page.mouse.down();
  await page.mouse.move(...at(104, 125), { steps: 2 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(handle).toBeVisible();
  await page.locator('[data-clip="title"]').click();
  await expect(handle).toBeHidden();
  await page.keyboard.press("ArrowRight");
  await expect(time).toHaveText("00:00:00:01");
  await expect(x).toHaveValue("0 px");
  expect(commands).toHaveLength(2);
});

test("the inspector edits a title's words in one undo step and refuses text with markup", async ({
  page,
  request,
}) => {
  const { project, at, commands, selected } = await open(page, request);
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const text = inspector.getByRole("textbox", { name: "Text", exact: true });
  const words = () =>
    page.frameLocator("iframe[data-live]").locator("#title").innerText();
  const source = () => readFile(join(project.path, "index.html"), "utf8");

  await page.mouse.click(...at(100, 125));
  await expect(selected).toHaveText("Title");
  await expect(text).toHaveValue("Launch day");
  await text.fill("Ship & tell");
  await text.press("Shift+Enter");
  await text.pressSequentially("today");
  await text.press("Enter");
  await expect(text).not.toBeFocused();
  await expect(text).toHaveValue("Ship & tell\ntoday");
  const timelineText = page.locator('[data-clip-label="title"] .tl-text');
  await expect(timelineText).toHaveText("Ship & tell");
  await expect.poll(words).toBe("Ship & tell\ntoday");
  expect(await source()).toContain(">Ship &amp; tell<br>today</div>");
  expect(commands).toHaveLength(1);
  await expect(
    inspector.locator(".inspector-changes li").first(),
  ).toContainText("Set text to “Ship & tell today”");

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(text).toHaveValue("Launch day");
  await expect.poll(words).toBe("Launch day");
  await expect(timelineText).toHaveText("Launch day");
  expect(await source()).toContain(">Launch day</div>");

  // Escape drops what was typed.
  await text.fill("Never saved");
  await text.press("Escape");
  await expect(text).toHaveValue("Launch day");
  expect(commands).toHaveLength(1);

  // Shapes have no words, so no field.
  await page.locator('[data-clip="badge"]').click();
  await expect(selected).toHaveText("Badge");
  await expect(text).toHaveCount(0);

  await page.locator('[data-clip="lower"]').click();
  await expect(selected).toHaveText("Lower");
  await expect(text).toBeDisabled();
  await expect(text).toHaveValue("Ada Park Editor");
  await expect(inspector).toContainText(
    "This text has markup inside it. Edit it in the source.",
  );
  expect(await source()).toContain("<b>Ada Park</b> <span>Editor</span>");
});

test("a held picture drag refuses a concurrent edit to the same clip", async ({
  page,
  request,
}) => {
  const { project, at, selected, drawn } = await open(page, request);
  await page.mouse.move(...at(100, 125));
  await page.mouse.down();
  await page.mouse.move(...at(120, 125), { steps: 4 });
  await expect(selected).toHaveText("Title");
  await expect.poll(async () => (await drawn("title")).left).toBe(80);
  const path = `/api/cutroom/projects/${project.id}/timeline`;
  const before = TimelineViewSchema.parse(
    await (await request.get(path)).json(),
  );
  const loaded = page.waitForResponse(
    (r) => r.request().method() === "GET" && r.url().endsWith("/timeline"),
  );
  const changed = await request.post(
    `/api/cutroom/projects/${project.id}/commands`,
    {
      data: {
        expectedRevision: before.revision,
        commands: [{ type: "setClip", clipId: "title", x: 100 }],
      },
    },
  );
  expect(changed.ok()).toBe(true);
  await loaded;
  await page.mouse.up();
  await expect(
    page.getByRole("alert").filter({ hasText: "changed those clips first" }),
  ).toBeVisible();
  await expect(positionField(page)).toHaveValue("100 px");
  const after = TimelineViewSchema.parse(
    await (await request.get(path)).json(),
  );
  expect(after.timeline.clips.find((c) => c.id === "title")!.x).toBe(100);
  await expect.poll(async () => (await drawn("title")).left).toBe(160);
});

test("a border paints only its edges when choosing a clip", async ({
  page,
  request,
}) => {
  const { at, selected } = await open(
    page,
    request,
    composition.replace(
      "#words{",
      "#words{border:15px solid white;box-sizing:border-box;",
    ),
  );
  await page.mouse.click(...at(345, 260));
  await expect(selected).toHaveText("Words");
  await page.mouse.click(...at(100, 180));
  await expect(selected).toHaveText("Shot");
  await page.mouse.click(...at(500, 280));
  await expect(selected).toHaveText("Shot");
});

test("changing tools releases the picture's arrow keys and hides the grab handles", async ({
  page,
  request,
}) => {
  const { at, selected, commands } = await open(page, request);
  await page.mouse.click(...at(100, 125));
  await expect(selected).toHaveText("Title");
  await page.mouse.click(...at(100, 125));
  const handle = page.locator(".edit-select-outline b").first();
  await expect(handle).toBeVisible();
  await page.keyboard.press("n");
  await expect(handle).toBeHidden();
  await expect(
    page.getByRole("application", { name: "Picture" }),
  ).not.toBeFocused();
  await page.keyboard.press("a");
  await expect(handle).toBeHidden();
  await expect(
    page.getByRole("application", { name: "Picture" }),
  ).toHaveAttribute("title", /click the selected clip again/i);
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("button", {
      name: "Current time. Click to type a time.",
      exact: true,
    }),
  ).toHaveText("00:00:00:01");
  expect(commands).toHaveLength(0);
});

test("class-targeted script text saves and warns only where the shown frame replaces it", async ({
  page,
  request,
}) => {
  const html = composition
    .replace("#title{", "#title{text-transform:uppercase;")
    .replace('id="title" class="clip"', 'id="title" class="clip live-title"')
    .replace(
      "window.__timelines.main=",
      "const words=document.querySelector('.live-title'); const saved=words.textContent; const state={t:0}; window.__timelines.main=",
    )
    .replace(
      ".to('#slide'",
      ".to(state,{t:3,duration:3,ease:'none',onUpdate:()=>{words.textContent=state.t>=1&&state.t<2?'Script words':saved}},0).to('#slide'",
    );
  const { project, at } = await open(page, request, html);
  await page.mouse.click(...at(100, 125));
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const field = inspector.getByRole("textbox", { name: "Text", exact: true });
  const warning = inspector.getByRole("status");
  await expect(field).toBeEnabled();
  await field.fill("Committed words");
  await field.press("Enter");
  await expect(field).toHaveValue("Committed words");
  await expect(
    page.frameLocator("iframe[data-live]").locator("#title"),
  ).toHaveText("Committed words");
  await expect(warning).toHaveCount(0);
  for (const frame of [30, 60, 30, 0]) {
    await seekFrame(page, frame);
    if (frame === 30) {
      await expect(warning).toHaveText(
        "This clip's script replaces its text at 00:00:01:00.",
      );
      await expect(field).toBeEnabled();
    } else await expect(warning).toHaveCount(0);
  }
  expect(await readFile(join(project.path, "index.html"), "utf8")).toContain(
    ">Committed words</div>",
  );
});

test("inline pre-line edits retain both lines and uncertain stylesheet whitespace is disabled", async ({
  page,
  request,
}) => {
  const multiline = composition.replace(
    ">Launch day</div>",
    ">First line\nSecond line</div>",
  );
  const { project, at } = await open(
    page,
    request,
    multiline.replace(
      'id="title" class="clip"',
      'id="title" class="clip" style="white-space:pre-line"',
    ),
  );
  await page.mouse.click(...at(100, 125));
  const field = page
    .getByRole("complementary", { name: "Inspector" })
    .getByRole("textbox", { name: "Text", exact: true });
  await expect(field).toHaveValue("First line\nSecond line");
  await expect(field).toBeEnabled();
  await field.fill("Updated line\nSecond line");
  await field.press("Enter");
  await expect(
    page.frameLocator("iframe[data-live]").locator("#title"),
  ).toHaveText("Updated lineSecond line");
  expect(await readFile(join(project.path, "index.html"), "utf8")).toContain(
    "Updated line<br>Second line",
  );
  const styled = await open(
    page,
    request,
    multiline.replace("#title{", "#title{white-space:pre-line;"),
  );
  await page.mouse.click(...styled.at(100, 125));
  await expect(field).toHaveValue("First line\nSecond line");
  await expect(field).toBeDisabled();
  await expect(
    page.getByRole("complementary", { name: "Inspector" }),
  ).toContainText(
    "This text may preserve source line breaks. Edit it in the source.",
  );
  expect(
    await readFile(join(styled.project.path, "index.html"), "utf8"),
  ).toContain("First line\nSecond line");
});

test("pointer-events stays authored in editor, thumbnail, timeline_view and MP4", async ({
  page,
  request,
  baseURL,
}, info) => {
  test.setTimeout(120_000);
  const project = await createPositionProject(
    request,
    { name: "Pointer style parity", width: 320, height: 240, duration: 1 },
    `<!doctype html><html><head><style>html,body{margin:0}main{width:320px;height:240px}#paint{position:absolute;inset:0;pointer-events:none}</style></head><body><main id="main" data-composition-id="main" data-width="320" data-height="240" data-fps="30" data-duration="1"><div id="paint" data-start="0" data-duration="1"></div></main><script>const paint=document.getElementById('paint'); function draw(){paint.style.background=getComputedStyle(paint).pointerEvents==='none'?'rgb(0,255,0)':'rgb(255,0,255)';requestAnimationFrame(draw)}draw();</script></body></html>`,
  );
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
  const painted = page.frameLocator("iframe[data-live]").locator("#paint");
  await expect(painted).toHaveCSS("pointer-events", "none");
  const authoredStyle = await painted.getAttribute("style");
  // Hit-testing still selects the pointer-transparent clip, without changing its paint.
  await page.locator(".edit-select").click({ position: { x: 100, y: 100 } });
  await expect(page.locator(".inspector-clip strong")).toHaveText("Paint");
  await expect(painted).toHaveCSS("pointer-events", "none");
  await expect(painted).toHaveCSS("background-color", "rgb(0, 255, 0)");
  expect(await painted.getAttribute("style")).toBe(authoredStyle);
  const editor = info.outputPath("editor.png");
  await painted.screenshot({ path: editor });
  const thumb = await request.get(
    `/api/projects/${project.id}/thumbnail/index.html?t=0&format=jpeg&output=source`,
  );
  expect(thumb.ok()).toBe(true);
  const thumbnail = info.outputPath("thumbnail.jpg");
  await writeFile(thumbnail, await thumb.body());
  const client = new Client({ name: "pointer-style-parity", version: "1.0" });
  const timeline = info.outputPath("timeline-view.jpg");
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
        requestInit: { headers: { origin: baseURL! } },
      }),
    );
    const result = await client.callTool({
      name: "timeline_view",
      arguments: { projectId: project.id, frame: 0 },
    });
    expect(result.isError).not.toBe(true);
    const image = CallToolResultSchema.parse(result).content.find(
      (item) => item.type === "image",
    );
    if (!image || image.type !== "image")
      throw new Error("No timeline_view image");
    await writeFile(timeline, Buffer.from(image.data, "base64"));
  } finally {
    await client.close();
  }
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const started = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/render"),
  );
  const dialog = page.getByRole("dialog", { name: "Export", exact: true });
  await dialog.getByRole("button", { name: "Export MP4" }).click();
  const { jobId } = z
    .object({ jobId: z.string() })
    .parse(await (await started).json());
  await expect(dialog).toContainText("Export complete.", { timeout: 90_000 });
  const mp4 = info.outputPath("export.mp4");
  await writeFile(
    mp4,
    await (await request.get(`/api/render/${jobId}/download`)).body(),
  );
  for (const file of [editor, thumbnail, timeline, mp4]) {
    const { stdout } = await promisify(execFile)(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        file,
        "-frames:v",
        "1",
        "-vf",
        "scale=1:1",
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      { encoding: "buffer" },
    );
    expect(stdout[0], file).toBeLessThan(10);
    expect(stdout[1], file).toBeGreaterThan(240);
    expect(stdout[2], file).toBeLessThan(10);
  }
});

for (const identity of ["data-hf-id", "generated"] as const) {
  test(`${identity} clips use their timeline identity for picture picks, outlines and drafts`, async ({
    page,
    request,
  }, info) => {
    const html = composition.replace(
      'id="badge"',
      `${identity === "data-hf-id" ? 'data-hf-id="front"' : ""} style="left:200px;top:110px;width:80px;height:30px;background:#3bd16f"`,
    );
    const { at, selected, scale, outlined } = await open(page, request, html);
    const id = identity === "data-hf-id" ? "front" : "clip-1";
    await page.locator(`[data-clip="${id}"]`).click();
    await expect(page.locator(".edit-select-outline")).toHaveAttribute(
      "data-outlined",
      id,
    );
    near(
      await outlined(),
      { left: 200, top: 110, width: 80, height: 30 },
      scale,
    );
    await page.locator('[data-clip="shot"]').click();
    await page.mouse.click(...at(240, 125));
    await expect(selected).toHaveText("Badge");
    await expect(page.locator(`[data-clip="${id}"]`)).toHaveClass(/selected/);
    await expect(page.locator(".edit-select-outline")).toHaveAttribute(
      "data-outlined",
      id,
    );
    await page.mouse.move(...at(240, 125));
    await page.mouse.down();
    await page.keyboard.down("Control");
    await page.mouse.move(...at(260, 135));
    await expect.poll(async () => (await outlined())?.left).toBeCloseTo(220, 0);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await page.keyboard.up("Control");
    await expect.poll(async () => (await outlined())?.left).toBeCloseTo(200, 0);
    await page.screenshot({
      path: info.outputPath(`${identity}-selected.png`),
    });
  });
}

for (const transform of [
  "scale(2)",
  "rotate(30deg)",
  "ancestor scale and rotate",
] as const) {
  test(`${transform} border picks its painted edge and leaves the centre empty`, async ({
    page,
    request,
  }) => {
    const css =
      transform === "ancestor scale and rotate"
        ? ""
        : `transform:${transform};`;
    let html = composition
      .replace(
        "#words{left:340px;top:200px;",
        `#words{border:15px solid white;box-sizing:border-box;transform-origin:top left;${css}left:100px;top:100px;`,
      )
      .replace(">Small words</div>", "></div>");
    if (transform === "ancestor scale and rotate")
      html = html
        .replace(
          '<div id="words"',
          '<section style="position:absolute;left:80px;top:0;transform:rotate(20deg) scale(1.5);transform-origin:top left"><div id="words"',
        )
        .replace('<div id="slide"', '</section><div id="slide"');
    const { at, selected } = await open(page, request, html);
    const point = async (x: number, y: number) =>
      page
        .frameLocator("iframe[data-live]")
        .locator("#words")
        .evaluate(
          (element, { x, y }) => {
            // Independent fixture geometry: multiply known transforms, anchored at the authored origin.
            const own = new DOMMatrix(
              getComputedStyle(element).transform === "none"
                ? undefined
                : getComputedStyle(element).transform,
            );
            let point = own.transformPoint({ x, y });
            point.x += 100;
            point.y += 100;
            const ancestor = element.parentElement!;
            if (ancestor.tagName === "SECTION") {
              point = new DOMMatrix(
                getComputedStyle(ancestor).transform,
              ).transformPoint(point);
              point.x += 80;
            }
            return { x: point.x, y: point.y };
          },
          { x, y },
        );
    // 10 local px is 20 composition px into the scale(2) border.
    const edge = await point(10, 50);
    await page.mouse.click(...at(edge.x, edge.y));
    await expect(selected).toHaveText("Words");
    // Clear the selection so its box cannot intentionally own the transparent centre.
    await page.keyboard.press("Escape");
    const centre = await point(120, 50);
    await page.mouse.click(...at(centre.x, centre.y));
    await expect(selected).toHaveText("Shot");
  });
}
