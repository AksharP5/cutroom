import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import { z } from "zod";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { afterPaint, seekFrame } from "./position-helpers";
import type { Page, APIRequestContext } from "@playwright/test";
import type { CommandInput } from "../src/shared/timeline/schema";
async function open(
  page: Page,
  request: APIRequestContext,
  script: string,
  clips?: string,
) {
  const p = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Animation follow-up" },
      })
    ).json(),
  );
  await copyFile(
    "node_modules/gsap/dist/gsap.min.js",
    join(p.path, "gsap.min.js"),
  );
  await writeFile(
    join(p.path, "index.html"),
    `<!doctype html><html><head><script src="gsap.min.js"></script><style>body{margin:0;background:#111;color:white;font:48px sans-serif}.clip{position:absolute;left:30px;top:80px}.still{top:180px}</style></head><body><main data-composition-id="main" data-width="640" data-height="360" data-duration="48" data-fps="30">${clips ?? '<div id="title" class="clip one shared" data-label="Title" data-start="6" data-duration="4" data-track-index="1">Title</div><div id="still" class="clip still shared" data-label="Still" data-start="6" data-duration="4" data-track-index="2">Still</div>'}</main><script>const tl=gsap.timeline({paused:true});window.__timelines.main=tl;${script}</script></body></html>`,
  );
  const reports: unknown[] = [];
  page.on("response", async (r) => {
    if (r.url().endsWith("/animation-windows"))
      reports.push(await r.json().catch(() => null));
  });
  await page.goto("/#project/" + p.id);
  await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
  await expect.poll(() => reports.length).toBeGreaterThan(0);
  if (!clips || clips.length < 5000)
    await page.locator('[data-clip="title"]').click();
  const base = "/api/cutroom/projects/" + p.id;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(base + "/timeline")).json(),
    );
  const raw = async (commands: CommandInput[]) => {
    const b = await read();
    const r = await request.post(base + "/commands", {
      data: {
        composition: "index.html",
        expectedRevision: b.revision,
        commands,
      },
    });
    expect(r.ok(), await r.text()).toBe(true);
  };
  const settled = async (commands: CommandInput[]) => {
    const count = reports.length;
    await afterPaint(page, () => raw(commands));
    await expect.poll(() => reports.length).toBeGreaterThan(count);
  };
  const warning = page.locator(".inspector-timing .inspector-warning");
  return { base, read, raw, settled, warning };
}

async function history(
  page: Page,
  request: APIRequestContext,
  base: string,
  direction: "undo" | "redo",
) {
  await afterPaint(page, async () => {
    const response = await request.post(`${base}/history/${direction}`);
    expect(response.ok(), await response.text()).toBe(true);
  });
}

async function holdPreviews(page: Page, action: () => Promise<void>) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/isolated-preview?*", async (route) => {
    await gate;
    await route.continue().catch(() => {});
  });
  try {
    await action();
  } finally {
    release();
    await page.unroute("**/isolated-preview?*");
  }
}

test("R4 rapid API moves keep cumulative evidence through reopen and both undo steps", async ({
  page,
  request,
}, info) => {
  const p = await open(page, request, "tl.to('.one',{x:100,duration:1},6);");
  await holdPreviews(page, async () => {
    await p.raw([{ type: "move", clipIds: ["title"], by: 60 }]);
    await p.raw([{ type: "move", clipIds: ["title"], by: 60 }]);
  });
  await expect
    .poll(async () =>
      page
        .frameLocator("iframe[data-live]")
        .locator("#title")
        .getAttribute("data-start"),
    )
    .toBe("10");
  await expect(p.warning).toContainText("00:00:06:00");
  await page.reload();
  await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
  await page.locator('[data-clip="title"]').click();
  await expect(p.warning).toBeVisible();
  for (const [direction, start, warned] of [
    ["undo", 8, true],
    ["undo", 6, false],
    ["redo", 8, true],
    ["redo", 10, true],
  ] as const) {
    await history(page, request, p.base, direction);
    expect(
      (await p.read()).timeline.clips.find((c) => c.id === "title")!.start,
    ).toBe(start * 30);
    if (warned) await expect(p.warning).toBeVisible();
    else await expect(p.warning).toHaveCount(0);
  }
  await page.screenshot({ path: info.outputPath("rapid-history.png") });
});

test("R4 rapid inspector Start edits retain their warning", async ({
  page,
  request,
}) => {
  const p = await open(page, request, "tl.to('.one',{x:100,duration:1},6);");
  await holdPreviews(page, async () => {
    const start = page.getByRole("textbox", { name: "Start", exact: true });
    await start.fill("240f");
    await start.press("Enter");
    await start.fill("300f");
    await start.press("Enter");
    await expect
      .poll(async () => (await p.read()).timeline.clips[0]!.start)
      .toBe(300);
  });
  await expect(p.warning).toContainText("00:00:06:00");
});

test("R4 function stagger follows the clip without a false warning", async ({
  page,
  request,
}, info) => {
  const p = await open(
    page,
    request,
    "tl.to('.shared',{x:100,duration:1,stagger:(i,target)=>+target.dataset.start-6},6);",
  );
  await p.settled([{ type: "move", clipIds: ["title"], by: 60 }]);
  await seekFrame(page, 255);
  const x = await page
    .frameLocator("iframe[data-live]")
    .locator("#title")
    .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41);
  expect(x).toBeCloseTo(75, 1);
  await expect(p.warning).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("following-stagger.png") });
});

test("R4 absolute keyframes still warn after a move", async ({
  page,
  request,
}, info) => {
  const p = await open(
    page,
    request,
    "tl.to('.one',{keyframes:[{x:100,duration:1},{x:0,duration:1}]},6);",
  );
  await p.settled([{ type: "move", clipIds: ["title"], by: 60 }]);
  await seekFrame(page, 255);
  await expect(p.warning).toContainText("00:00:06:00");
  await page.screenshot({ path: info.outputPath("absolute-keyframes.png") });
});

test("R4 razor evidence survives deleting its source piece", async ({
  page,
  request,
}, info) => {
  const p = await open(
    page,
    request,
    "tl.to('.one',{x:100,duration:1},6);tl.to('.one',{x:0,duration:1},9);",
  );
  await p.settled([{ type: "move", clipIds: ["title"], by: 60 }]);
  await expect(p.warning).toBeVisible();
  await p.settled([{ type: "split", clipIds: ["title"], at: 270 }]);
  const right = (await p.read()).timeline.clips.find((c) => c.start === 270)!;
  await p.settled([{ type: "remove", clipIds: ["title"], ripple: false }]);
  await page.locator(`[data-clip="${right.id}"]`).click();
  await seekFrame(page, 285);
  await expect(p.warning).toContainText("00:00:06:00");
  await page.screenshot({ path: info.outputPath("razor-source-deleted.png") });
});

test("R4 paste at the same origin inherits an existing warning", async ({
  page,
  request,
}) => {
  const p = await open(page, request, "tl.to('.one',{x:100,duration:1},6);");
  await p.settled([{ type: "move", clipIds: ["title"], by: 60 }]);
  await expect(p.warning).toBeVisible();
  const before = await p.read();
  const copied = await request.post(`${p.base}/timeline/copy`, {
    data: {
      composition: "index.html",
      expectedRevision: before.revision,
      clipIds: ["title"],
    },
  });
  const clipboard = await copied.json();
  await p.settled([
    { type: "paste", clipboardId: clipboard.id, at: 240, mode: "insert" },
  ]);
  const copy = (await p.read()).timeline.clips.find(
    (c) => c.id !== "title" && c.start === 240,
  )!;
  await page.locator(`[data-clip="${copy.id}"]`).click();
  await expect(p.warning).toContainText("00:00:06:00");
});

for (const mutation of [
  "tl.shiftChildren(2)",
  "tl.getChildren(false,true,false)[0].startTime(8)",
]) {
  test(`R4 timing mutation clears warning: ${mutation}`, async ({
    page,
    request,
  }, info) => {
    const p = await open(
      page,
      request,
      `tl.to('.one',{x:100,duration:1},6);if(+document.querySelector('.one').dataset.start===8)setTimeout(()=>${mutation},1800);`,
    );
    await p.settled([{ type: "move", clipIds: ["title"], by: 60 }]);
    await expect(p.warning).toBeVisible();
    await expect(p.warning).toHaveCount(0);
    await seekFrame(page, 255);
    const x = await page
      .frameLocator("iframe[data-live]")
      .locator("#title")
      .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41);
    expect(x).toBeCloseTo(75, 1);
    await page.screenshot({ path: info.outputPath("timing-fixed.png") });
  });
}

test("reopening a warning recorded before comparison inputs preserves it", async ({
  page,
  request,
}) => {
  const p = await open(page, request, "tl.to('.one',{x:100,duration:1},6);");
  await p.settled([{ type: "move", clipIds: ["title"], by: 60 }]);
  await expect(p.warning).toBeVisible();
  const project = ProjectSchema.parse(await (await request.get(p.base)).json());
  const path = join(project.path, ".cutroom/review.json");
  const ledger = JSON.parse(await readFile(path, "utf8"));
  ledger.animationEdits = ledger.animationEdits.map(
    ({
      historyId,
      composition,
      results,
    }: {
      historyId: string;
      composition: string;
      results: unknown;
    }) => ({ historyId, composition, results }),
  );
  await writeFile(path, JSON.stringify(ledger));
  await page.reload();
  await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
  await page.locator('[data-clip="title"]').click();
  await expect(p.warning).toContainText("00:00:06:00");
});
