import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProjectSchema } from "../src/shared/project";
import { expect, test } from "./fixtures";

test("500 clips: position scrubs paint live, cancel cleanly and commit one undo step", async ({
  page,
  request,
}, info) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Live position", width: 640, height: 360, duration: 250 },
      })
    ).json(),
  );
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><style>html,body{margin:0;background:#142039}main{position:relative} .title{position:absolute;left:60px;top:100px;width:100px;height:50px;background:lime;color:black;font:24px sans-serif}</style></head><body><main id="main" data-composition-id="main" data-width="640" data-height="360" data-fps="30" data-duration="250">${Array.from({ length: 500 }, (_, i) => `<div id="title-${i}" class="clip title" data-start="${Math.floor(i / 2)}" data-duration="1" data-track-index="${i % 2}" style="top:${100 + (i % 2) * 70}px">Title ${i}</div>`).join("")}</main></body></html>`,
  );
  await page.goto(`/#project/${project.id}`);
  await page.locator('[data-clip="title-0"]').click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const field = inspector.getByRole("textbox", {
    name: "Position X",
    exact: true,
  });
  await expect(field).toBeVisible();
  await expect(page.locator("iframe[data-live]")).toBeVisible();
  const x = () =>
    page
      .frameLocator("iframe[data-live]")
      .locator("#title-0")
      .evaluate((el) => el.getBoundingClientRect().left);
  await expect.poll(x).toBe(60);
  const commands: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/commands"))
      commands.push(r.postData()!);
  });
  await page.evaluate(() => {
    const stats = {
      frames: [] as number[],
      iframes: 0,
      timeline: 0,
      mutations: [] as string[],
      done: false,
    };
    Object.assign(window, { positionStats: stats });
    let last = performance.now();
    const tick = (now: number) => {
      stats.frames.push(now - last);
      last = now;
      if (!stats.done) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
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
      stats.mutations.push(
        ...records.map(
          (r) =>
            `${r.type}:${(r.target as Element).className}:${r.attributeName}`,
        ),
      );
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
  await page.screenshot({
    caret: "initial",
    path: info.outputPath("scrub-0.png"),
  });
  await page.mouse.move(box.x + 10, box.y + 5);
  await page.mouse.down();
  await page.evaluate(async () => {
    await new Promise<void>((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => r())),
    );
    const stats = (
      window as unknown as {
        positionStats: { frames: number[]; iframes: number; timeline: number };
      }
    ).positionStats;
    stats.frames = [];
    stats.iframes = 0;
    stats.timeline = 0;
    (stats as unknown as { mutations: string[] }).mutations = [];
  });
  for (let i = 1; i <= 60; i++) {
    await page.mouse.move(box.x + 10 + i * 2, box.y + 5);
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => r())),
    );
    if (i === 30)
      await page.screenshot({
        caret: "initial",
        path: info.outputPath("scrub-60.png"),
      });
  }
  const during = await x();
  const stats = await page.evaluate(() => {
    const stats = (
      window as unknown as {
        positionStats: {
          frames: number[];
          iframes: number;
          timeline: number;
          done: boolean;
        };
      }
    ).positionStats;
    stats.done = true;
    const times = stats.frames.slice(2).sort((a, b) => a - b);
    return {
      median: times[Math.floor(times.length / 2)],
      p95: times[Math.floor(times.length * 0.95)],
      iframeAdditions: stats.iframes,
      timelineMutations: stats.timeline,
      mutations: (stats as unknown as { mutations: string[] }).mutations,
    };
  });
  await page.screenshot({
    caret: "initial",
    path: info.outputPath("scrub-120.png"),
  });
  await writeFile(
    info.outputPath("scrub-timing.json"),
    JSON.stringify(
      {
        ...stats,
        pictureX: during,
        field: await field.inputValue(),
        commandsDuring: commands.length,
      },
      null,
      2,
    ),
  );
  expect(during).toBe(180);
  expect(commands).toHaveLength(0);
  expect(stats.iframeAdditions).toBe(0);
  expect(stats.timelineMutations).toBe(0);
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
