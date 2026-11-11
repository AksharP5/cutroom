import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import {
  createPositionProject,
  positionField,
  waitFrames,
} from "./position-helpers";

test("500 clips: position scrubs paint live, cancel cleanly and commit one undo step", async ({
  page,
  request,
}) => {
  const project = await createPositionProject(request, {
    name: "Live position",
    width: 640,
    height: 360,
    duration: 250,
  });
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><style>html,body{margin:0;background:#142039}main{position:relative} .title{position:absolute;left:60px;top:100px;width:100px;height:50px;background:lime;color:black;font:24px sans-serif}</style></head><body><main id="main" data-composition-id="main" data-width="640" data-height="360" data-fps="30" data-duration="250">${Array.from({ length: 500 }, (_, i) => `<div id="title-${i}" class="clip title" data-start="${Math.floor(i / 2)}" data-duration="1" data-track-index="${i % 2}" style="top:${100 + (i % 2) * 70}px">Title ${i}</div>`).join("")}</main></body></html>`,
  );
  await page.goto(`/#project/${project.id}`);
  await page.locator('[data-clip="title-0"]').click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const field = positionField(page);
  await expect(field).toBeVisible();
  await expect(page.locator("iframe[data-live]")).toBeVisible();
  const x = () =>
    page
      .frameLocator("iframe[data-live]")
      .locator("#title-0")
      .evaluate((el) => el.getBoundingClientRect().left);
  await expect.poll(x).toBe(60);
  const commands: string[] = [];
  const serverRequests: string[] = [];
  let measuring = false;
  page.on("request", (r) => {
    if (measuring && r.url().includes("/api/")) serverRequests.push(r.url());
    if (r.method() === "POST" && r.url().endsWith("/commands"))
      commands.push(r.postData()!);
  });
  await page.evaluate(() => {
    const stats = { iframes: 0, timeline: 0 };
    Object.assign(window, { positionStats: stats });
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes)
          if (n instanceof Element)
            stats.iframes +=
              Number(n.matches("iframe")) + n.querySelectorAll("iframe").length;
    }).observe(document.body, { childList: true, subtree: true });
    const timeline = document.querySelector(".tl");
    if (!timeline) throw new Error("Timeline missing");
    new MutationObserver((records) => {
      stats.timeline += records.length;
    }).observe(timeline, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
  const label = inspector.locator("label").filter({ hasText: /^Position X$/ });
  const box = await label.boundingBox();
  if (!box) throw new Error("Position label missing");
  await page.mouse.move(box.x + 10, box.y + 5);
  await page.mouse.down();
  await waitFrames(page);
  await page.evaluate(() => {
    const stats = (
      window as unknown as {
        positionStats: { iframes: number; timeline: number };
      }
    ).positionStats;
    stats.iframes = 0;
    stats.timeline = 0;
  });
  measuring = true;
  for (let i = 1; i <= 60; i++) {
    await page.mouse.move(box.x + 10 + i * 2, box.y + 5);
    await waitFrames(page, 1);
  }
  measuring = false;
  const during = await x();
  const stats = await page.evaluate(
    () =>
      (
        window as unknown as {
          positionStats: { iframes: number; timeline: number };
        }
      ).positionStats,
  );
  expect(during).toBe(180);
  expect(commands).toHaveLength(0);
  expect(stats.iframes).toBe(0);
  expect(serverRequests).toEqual([]);
  expect(stats.timeline).toBe(0);
  await page.mouse.up();
  await expect(field).toHaveValue("120 px");
  await expect.poll(() => commands.length).toBe(1);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(field).toHaveValue("0 px");
  await expect.poll(x).toBe(60);
  await page.mouse.move(box.x + 10, box.y + 5);
  await page.mouse.down();
  await page.mouse.move(box.x + 50, box.y + 5);
  await expect.poll(x).toBe(100);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect.poll(x).toBe(60);
  expect(commands).toHaveLength(1);
  await field.focus();
  await page.keyboard.down("ArrowUp");
  await page.keyboard.down("ArrowUp");
  await expect.poll(x).toBe(62);
  expect(commands).toHaveLength(1);
  const stage = page.locator(".edit-stage[data-preview-ready]");
  const beforeKeys = await stage.getAttribute("data-preview-ready");
  await page.keyboard.up("ArrowUp");
  await expect.poll(() => commands.length).toBe(2);
  await expect(stage).not.toHaveAttribute("data-preview-ready", beforeKeys!);
  await expect(stage).toBeVisible();
  await page.keyboard.down("ArrowUp");
  await page.keyboard.down("ArrowUp");
  await expect.poll(x).toBe(64);
  await field.press("Escape");
  await page.keyboard.up("ArrowUp");
  await expect.poll(x).toBe(62);
  expect(commands).toHaveLength(2);
});

test("delayed promotion preserves a second Position drag and returning step keys to the saved value retires its draft", async ({
  page,
  request,
}) => {
  const project = await createPositionProject(request, {
    name: "Position handoff",
    width: 640,
    height: 360,
    duration: 2,
  });
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><style>html,body{margin:0;background:#142039}#title{position:absolute;left:60px;top:100px;width:100px;height:50px;background:lime;color:black;font:24px sans-serif}</style></head><body><main id="main" data-composition-id="main" data-width="640" data-height="360" data-fps="30" data-duration="2"><div id="title" class="clip" data-start="0" data-duration="2">Title</div></main></body></html>`,
  );
  // Each opaque document samples its actual subject on rAF. The parent records only the
  // document displayed at that instant, including the first frame after promotion.
  await page.addInitScript(() => {
    if (window === parent) {
      const proof = {
        recording: false,
        samples: [] as { x: number; at: number; document: string }[],
      };
      Object.assign(window, { positionHandoff: proof });
      addEventListener("message", (event) => {
        if (event.data?.source !== "position-handoff-proof" || !proof.recording)
          return;
        const live =
          document.querySelector<HTMLIFrameElement>("iframe[data-live]");
        if (live?.contentWindow === event.source)
          proof.samples.push({
            x: event.data.x,
            at: event.data.at,
            document: live.src,
          });
      });
      return;
    }
    const sample = () => {
      const title = document.getElementById("title");
      if (title)
        parent.postMessage(
          {
            source: "position-handoff-proof",
            x: title.getBoundingClientRect().left,
            at: performance.timeOrigin + performance.now(),
          },
          "*",
        );
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.goto(`/#project/${project.id}`);
  await page.locator('[data-clip="title"]').click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const field = positionField(page);
  const label = inspector.locator("label").filter({ hasText: /^Position X$/ });
  const stage = page.locator(".edit-stage[data-preview-ready]");
  await expect(stage).toBeVisible();
  const box = await label.boundingBox();
  if (!box) throw new Error("Position label missing");
  const x = () =>
    page
      .frameLocator("iframe[data-live]")
      .locator("#title")
      .evaluate((el) => el.getBoundingClientRect().left);
  await expect.poll(x).toBe(60);
  const blocked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let held = false;
  await page.route("**/isolated-preview?*", async (route) => {
    if (!held) {
      held = true;
      blocked.resolve();
      await release.promise;
      await route.continue();
    } else await route.continue();
  });
  await page.mouse.move(box.x + 10, box.y + 5);
  await page.mouse.down();
  await page.mouse.move(box.x + 50, box.y + 5);
  await expect.poll(x).toBe(100);
  await page.mouse.up();
  await blocked.promise;
  await expect(field).toHaveValue("40 px");
  await page.mouse.move(box.x + 10, box.y + 5);
  await page.mouse.down();
  await page.mouse.move(box.x + 70, box.y + 5);
  await expect(field).toHaveValue("100 px");
  await expect.poll(x).toBe(160);
  await page.evaluate(() => {
    (
      window as unknown as { positionHandoff: { recording: boolean } }
    ).positionHandoff.recording = true;
  });
  release.resolve();
  await expect(stage).toBeVisible();
  // The per-frame samples include the first displayed frame after delayed promotion.
  await waitFrames(page, 6);
  const samples = await page.evaluate(() => {
    const proof = (
      window as unknown as {
        positionHandoff: {
          recording: boolean;
          samples: { x: number; at: number; document: string }[];
        };
      }
    ).positionHandoff;
    proof.recording = false;
    return proof.samples;
  });
  expect(new Set(samples.map((sample) => sample.document)).size).toBe(2);
  expect(samples.length).toBeGreaterThan(6);
  expect(
    samples.every((sample) => sample.x === 160),
    JSON.stringify(samples),
  ).toBe(true);
  await expect(field).toHaveValue("100 px");
  await page.mouse.move(box.x + 90, box.y + 5);
  await expect.poll(x).toBe(180);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(field).toHaveValue("40 px");
  await expect.poll(x).toBe(100);
  // Returning held step keys to the saved value must retire the draft too. Otherwise
  // its cached offset would be replayed over the document produced by Undo.
  await field.focus();
  await page.keyboard.down("ArrowUp");
  await page.keyboard.down("ArrowDown");
  await page.keyboard.up("ArrowUp");
  await page.keyboard.up("ArrowDown");
  await field.press("Enter");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(field).toHaveValue("0 px");
  await expect.poll(x).toBe(60);
});
