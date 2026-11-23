import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { ProjectSchema } from "../src/shared/project";
import { expect, test } from "./fixtures";
import { seekFrame } from "./position-helpers";

/** The agent's Hero ramp from the design spec: 100% to 160% to 25% and back, over 6 s. */
const HERO = JSON.stringify({
  version: 1,
  lanes: [
    {
      target: "rate",
      points: [
        { t: 0, v: 1 },
        { t: 1.5, v: 1.6 },
        { t: 3, v: 0.25 },
        { t: 4.5, v: 1.6 },
        { t: 6, v: 1 },
      ],
    },
  ],
});

async function rampProject(page: Page, request: Page["request"], plain = "") {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Speed ramps", width: 640, height: 360 },
      })
    ).json(),
  );
  await promisify(execFile)("ffmpeg", [
    ...["-v", "error", "-f", "lavfi", "-i"],
    "testsrc2=s=320x180:r=30:d=10",
    ...["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"],
    join(project.path, "broll.mp4"),
  ]);
  const video = (id: string, start: number, attrs = "") =>
    `<video id="${id}" class="clip" src="broll.mp4" muted data-start="${start}" data-duration="6" data-track-index="0" ${attrs} style="position:absolute;inset:0;width:100%;height:100%"></video>`;
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><body><main id="main" data-composition-id="main" data-width="640" data-height="360" data-fps="30" data-duration="12">${video("plain", 0, plain)}${video("broll", 6, `data-automation='${HERO}'`)}</main></body></html>`,
  );
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
  return project;
}

test("a ramp an agent wrote shows on its clip and in Timing", async ({
  page,
  request,
}) => {
  await rampProject(page, request);
  // Drawn whether or not the clip is selected, and only on the ramped clip.
  const line = page.locator('[data-clip-speed="broll"]');
  await expect(line).toBeVisible();
  await expect(line.locator(".tl-volume-point")).toHaveCount(5);
  await expect(page.locator('[data-clip-speed="plain"]')).toHaveCount(0);

  await page.locator('[data-clip="broll"]').click();
  await seekFrame(page, 180 + 45);
  const timing = page.locator(".inspector-timing");
  await expect(timing.getByLabel("Speed", { exact: true })).toHaveValue("160%");
  await expect(timing.getByLabel("Source out")).toHaveText("00:00:05:29");
  const graph = timing.getByRole("img", { name: "Speed over the clip" });
  await expect(graph.locator(".speed-point")).toHaveCount(5);
  await expect(graph.locator(".speed-point[data-on]")).toHaveCount(1);

  // Outside the clip, the field reads the speed at its first frame.
  await seekFrame(page, 30);
  await expect(timing.getByLabel("Speed", { exact: true })).toHaveValue("100%");
  await expect(graph.locator(".speed-playhead")).toHaveCount(0);

  const diamond = timing.getByRole("button", {
    name: "Speed point",
    exact: true,
  });
  await expect(diamond).toBeDisabled();
  await expect(diamond).toHaveAttribute("aria-pressed", "false");
  await expect(diamond).toHaveAttribute("data-state", "keyed");

  await seekFrame(page, 180 + 15);
  await expect(timing.getByLabel("Speed", { exact: true })).toHaveValue("117%");

  // A constant clip keeps its typed Speed field and draws nothing.
  await page.locator('[data-clip="plain"]').click();
  await expect(timing.getByLabel("Speed", { exact: true })).toBeEnabled();
  await expect(graph).toHaveCount(0);
});

test("speed points, eases, presets and reset each edit as one undo step", async ({
  page,
  request,
}) => {
  await rampProject(page, request);
  await page.locator('[data-clip="broll"]').click();
  await seekFrame(page, 180 + 45);
  const timing = page.locator(".inspector-timing");
  const speed = timing.getByLabel("Speed", { exact: true });
  const points = page.locator('[data-clip-speed="broll"] .tl-volume-point');

  // Typing sets the point under the playhead.
  await speed.fill("200%");
  await speed.press("Enter");
  await expect(speed).toHaveValue("200%");
  await page.keyboard.press("Control+z");
  await expect(speed).toHaveValue("160%");
  await page.keyboard.press("Control+Shift+z");
  await expect(speed).toHaveValue("200%");
  await page.keyboard.press("Control+z");
  await expect(speed).toHaveValue("160%");

  // Ease shapes the segment from the point at the playhead.
  const easeInOut = timing.getByRole("radio", { name: "Ease in and out" });
  await easeInOut.click();
  await expect(easeInOut).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Control+z");
  await expect(easeInOut).toHaveAttribute("aria-checked", "false");

  // The diamond removes the point under the playhead and adds one where there is none.
  const diamond = timing.getByRole("button", { name: "Speed point" });
  await diamond.click();
  await expect(points).toHaveCount(4);
  await page.keyboard.press("Control+z");
  await expect(points).toHaveCount(5);

  // A preset replaces the points with its own.
  await timing.getByRole("button", { name: "Presets" }).click();
  await page.getByRole("menuitem", { name: "Speed into cut" }).click();
  await expect(points).toHaveCount(2);
  await page.keyboard.press("Control+z");
  await expect(points).toHaveCount(5);

  // Reset speed, from its key and from the clip menu.
  await page.keyboard.press("Control+Alt+r");
  await expect(page.locator('[data-clip-speed="broll"]')).toHaveCount(0);
  await expect(speed).toHaveValue("100%");
  await page.keyboard.press("Control+z");
  await expect(points).toHaveCount(5);
  await page.locator('[data-clip="broll"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "Reset speed" }).click();
  await expect(page.locator('[data-clip-speed="broll"]')).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect(points).toHaveCount(5);

  // A speed the source can't hold is refused with the most this point can take.
  await page.locator('[data-clip="broll"]').click();
  await speed.fill("1000%");
  await speed.press("Enter");
  await expect(page.locator(".toast")).toContainText(
    /runs past the end of its source at 00:00:\d\d:\d\d; the most the point at 00:00:07:15 can take is \d+%/,
  );
  await expect(speed).toHaveValue("160%");
});

test("typing a speed outside a ramp leaves its points alone", async ({
  page,
  request,
}) => {
  await rampProject(page, request);
  await page.locator('[data-clip="broll"]').click();
  await seekFrame(page, 30);
  const speed = page
    .locator(".inspector-timing")
    .getByLabel("Speed", { exact: true });
  await speed.fill("50%");
  await speed.press("Enter");
  await expect(speed).toHaveValue("100%", { timeout: 2000 });
  await seekFrame(page, 180);
  await expect(speed).toHaveValue("100%");
  await seekFrame(page, 225);
  await expect(speed).toHaveValue("160%");
});

test("a source-limited Slow-mo hit applies and explains the speed it reached", async ({
  page,
  request,
}) => {
  await rampProject(
    page,
    request,
    'data-playback-rate="0.2" data-media-start="8.8"',
  );
  await page.locator('[data-clip="plain"]').click();
  await seekFrame(page, 120);
  const timing = page.locator(".inspector-timing");
  const sourceBefore = timing.getByLabel("Source out");
  await expect(sourceBefore).toHaveText("00:00:09:29");
  await timing.getByRole("button", { name: "Presets" }).click();
  await page.getByRole("menuitem", { name: "Slow-mo hit" }).click();
  await expect(page.locator(".toast")).toContainText(
    "Not enough source after the hit. Slowed to 20%.",
  );
  await expect(timing.getByLabel("Speed", { exact: true })).toHaveValue("20%");
  await expect(
    page.locator('[data-clip-speed="plain"] .tl-volume-point'),
  ).toHaveCount(4);
});

test("owner and agent undo and redo their own speed ramps", async ({
  page,
  request,
  baseURL,
}) => {
  const project = await rampProject(page, request);
  const agent = new Client({ name: "Codex", version: "1" });
  await agent.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
      requestInit: { headers: { origin: baseURL! } },
    }),
  );
  const timeline = async () =>
    TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    );
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const reply = await agent.callTool({
      name,
      arguments: { projectId: project.id, ...args },
    });
    expect(reply.isError, JSON.stringify(reply.content)).not.toBe(true);
  };
  try {
    await page.locator('[data-clip="broll"]').click();
    await seekFrame(page, 225);
    const speed = page
      .locator(".inspector-timing")
      .getByLabel("Speed", { exact: true });
    const saved = page.waitForResponse((response) =>
      response.url().endsWith("/commands"),
    );
    await speed.fill("200%");
    await speed.press("Enter");
    expect((await saved).ok()).toBe(true);
    await call("timeline_edit", {
      expectedRevision: (await timeline()).revision,
      commands: [
        {
          type: "setSpeed",
          clipId: "plain",
          points: [
            { frame: 0, speed: 0.5 },
            { frame: 90, speed: 1 },
          ],
        },
      ],
    });
    const plain = page.locator('[data-clip-speed="plain"]');
    await expect(plain).toBeVisible();

    await page.keyboard.press("Control+z");
    await expect(speed).toHaveValue("160%");
    await expect(plain).toBeVisible();
    await page.keyboard.press("Control+Shift+z");
    await expect(speed).toHaveValue("200%");

    await call("history_undo");
    await expect(plain).toHaveCount(0);
    await expect(speed).toHaveValue("200%");
    await call("history_redo");
    await expect(plain).toBeVisible();
    await expect(speed).toHaveValue("200%");
  } finally {
    await agent.close();
  }
});

/** The clip's ramp as the server saved it: each point's curve time and speed. */
const savedRamp = async (page: Page, clipId: string) => {
  const project = page.url().split("#project/")[1]!;
  const { timeline } = await (
    await page.request.get(`/api/cutroom/projects/${project}/timeline`)
  ).json();
  const clip = timeline.clips.find(
    (item: { id: string }) => item.id === clipId,
  );
  return {
    duration: clip.duration as number,
    playbackRate: clip.playbackRate as number,
    points: clip.automation
      ? (
          JSON.parse(clip.automation).lanes as {
            target: string;
            points: unknown[];
          }[]
        ).find((lane) => lane.target === "rate")?.points
      : undefined,
  };
};

test("speed points drag on the clip, with the playhead and viewer following, and Esc puts them back", async ({
  page,
  request,
}) => {
  await rampProject(page, request);
  await page.locator('[data-clip="broll"]').click();
  const before = await savedRamp(page, "broll");
  const clock = page.getByRole("button", {
    name: "Current time. Click to type a time.",
  });
  const handle = page.locator(
    '[data-clip-speed="broll"] [data-speed-point="1"]',
  );
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  // Esc during a drag puts the point back and saves nothing.
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 8, { steps: 4 });
  await expect(page.locator(".tl-readout")).toContainText("% at 00:00:07:15");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(await savedRamp(page, "broll")).toEqual(before);

  // Up by 6 px snaps to 400%; the playhead rides the point and stays there.
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 6, { steps: 3 });
  await expect(page.locator(".tl-readout")).toHaveText("400% at 00:00:07:15");
  await expect(clock).toHaveText("00:00:07:15");
  await page.mouse.up();
  await expect
    .poll(async () => (await savedRamp(page, "broll")).points?.[1])
    .toEqual({ t: 1.5, v: 4 });
  await expect(clock).toHaveText("00:00:07:15");
  await page.keyboard.press("Control+z");
  await expect.poll(() => savedRamp(page, "broll")).toEqual(before);

  // Alt-click on the line adds a point at the line's speed; on a point, removes it.
  const points = page.locator('[data-clip-speed="broll"] [data-speed-point]');
  const clipBox = (await page
    .locator('[data-clip-speed="broll"]')
    .boundingBox())!;
  const third = page.locator(
    '[data-clip-speed="broll"] [data-speed-point="2"]',
  );
  const thirdBox = (await third.boundingBox())!;
  // Halfway from the second point to the third, on the straight log segment between them.
  const lineX = (x + thirdBox.x + thirdBox.width / 2) / 2;
  const lineY = (y + thirdBox.y + thirdBox.height / 2) / 2;
  expect(lineX).toBeGreaterThan(clipBox.x);
  await page.keyboard.down("Alt");
  await page.mouse.click(lineX, lineY);
  await page.keyboard.up("Alt");
  await expect(points).toHaveCount(6);
  await page.keyboard.down("Alt");
  await points.nth(2).click();
  await page.keyboard.up("Alt");
  await expect(points).toHaveCount(5);
});

test("Ctrl+R shows a constant clip's speed line, which drags its speed", async ({
  page,
  request,
}) => {
  await rampProject(page, request);
  await page.locator('[data-clip="plain"]').click();
  const line = page.locator('[data-clip-speed="plain"]');
  await expect(line).toHaveCount(0);
  await page.keyboard.press("Control+r");
  await expect(line).toBeVisible();
  await page.locator('[data-clip="plain"]').click({ button: "right" });
  await expect(
    page.getByRole("menuitemcheckbox", { name: "Show speed curve" }),
  ).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");

  // Dragging the flat line up to the 200% snap doubles the speed, so the clip halves.
  const band = (await line.locator(".tl-fade-curve").boundingBox())!;
  const x = band.x + band.width / 2;
  const y = band.y + band.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let dy = 1; dy <= 6; dy++) await page.mouse.move(x, y - dy);
  await expect(page.locator(".tl-readout")).toHaveText("200%");
  await page.mouse.up();
  await expect
    .poll(() => savedRamp(page, "plain"))
    .toMatchObject({ playbackRate: 2, duration: 90 });
  await page.keyboard.press("Control+r");
  await expect(line).toHaveCount(0);
});

test("the speed graph edits points by pointer and by key", async ({
  page,
  request,
}) => {
  await rampProject(page, request);
  await page.locator('[data-clip="broll"]').click();
  await seekFrame(page, 180 + 45);
  const graph = page
    .locator(".inspector-timing")
    .getByRole("group", { name: "Speed over the clip" });
  const point = graph.getByRole("button", {
    name: "Speed point at 00:00:07:15, 160%",
  });

  // Keys: Up steps to the next speed in the list, Right a frame, Shift+Right ten.
  await point.focus();
  await page.keyboard.press("ArrowUp");
  await expect(
    graph.getByRole("button", { name: "Speed point at 00:00:07:15, 200%" }),
  ).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await expect
    .poll(async () => (await savedRamp(page, "broll")).points?.[1])
    .toEqual({ t: 1.866667, v: 2 });
  // Delete removes the focused point.
  await page.keyboard.press("Delete");
  await expect(graph.locator(".speed-point")).toHaveCount(4);
  for (let undo = 0; undo < 4; undo++) await page.keyboard.press("Control+z");
  await expect(graph.locator(".speed-point")).toHaveCount(5);

  // A drag stopped by the end of the source says why, and saves the most it allows.
  const last = graph.locator(".speed-point").nth(3);
  const box = (await last.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y - 200, { steps: 6 });
  await expect(page.locator(".speed-hint")).toContainText(
    /^Source ends\. \d+% is the most this point can go\.$/,
  );
  await page.mouse.up();
  await expect(page.locator(".speed-hint")).toHaveCount(0);
  await expect
    .poll(async () => (await savedRamp(page, "broll")).points?.[3])
    .not.toEqual({ t: 4.5, v: 1.6 });
});
