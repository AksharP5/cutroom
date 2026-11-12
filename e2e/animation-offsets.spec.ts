import { spawnSync } from "node:child_process";
import { cp, copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import type { CommandInput } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";
import { afterPaint } from "./position-helpers";

const rootTimeline =
  "const tl = gsap.timeline({paused:true}); window.__timelines.main = tl;";
function document(script: string) {
  return `<!doctype html><html><head><script src="gsap.min.js"></script><style>body{margin:0;background:#111;color:#eee;font:48px sans-serif}.clip{position:absolute;top:80px;left:30px}.still{top:180px}</style></head><body><main data-composition-id="main" data-width="640" data-height="360" data-duration="48" data-fps="30"><div id="title" class="clip one shared" data-start="6" data-duration="4" data-track-index="1" data-label="Title">Title</div><div id="still" class="clip still shared" data-start="6" data-duration="4" data-track-index="2">Still</div></main><script>${script}</script></body></html>`;
}
async function open(
  page: Page,
  request: APIRequestContext,
  content: { script: string } | { fixture: string },
) {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Animation offsets" },
      })
    ).json(),
  );
  if ("script" in content)
    await writeFile(join(project.path, "index.html"), document(content.script));
  else
    await cp(
      join(import.meta.dirname, "fixtures/title-sync", content.fixture),
      project.path,
      { recursive: true },
    );
  await copyFile(
    "node_modules/gsap/dist/gsap.min.js",
    join(project.path, "gsap.min.js"),
  );
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
  await expect(page.locator(".tl-grid")).toHaveAttribute(
    "data-refit",
    "settled",
  );
  // Allow the timer-built fixture to register its before-edit report.
  await page.waitForTimeout(1500);
  const base = `/api/cutroom/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${base}/timeline`)).json(),
    );
  const edit = async (commands: CommandInput[]) => {
    const before = await read();
    await afterPaint(page, async () => {
      const response = await request.post(`${base}/commands`, {
        data: {
          composition: "index.html",
          expectedRevision: before.revision,
          commands,
        },
      });
      expect(response.ok(), await response.text()).toBe(true);
    });
  };
  const select = async (id: string) =>
    page.locator(`[data-clip="${id}"]`).click();
  const warning = page.locator(".inspector-timing .inspector-warning");
  const toast = page
    .locator(".toast")
    .filter({ hasText: /animation stayed|animation behind/ });
  const silent = async () => {
    await page.waitForTimeout(1500);
    await expect(warning).toHaveCount(0);
    await expect(toast).toHaveCount(0);
  };
  return { project, base, read, edit, select, warning, toast, silent };
}

test("shared-selector move warns only the moved clip; undo clears and redo warns", async ({
  page,
  request,
}, info) => {
  const p = await open(page, request, {
    script: `${rootTimeline}tl.fromTo('.shared',{opacity:0},{opacity:1,duration:.5},6);`,
  });
  await p.select("title");
  await p.edit([{ type: "move", clipIds: ["title"], by: 60 }]);
  await expect(p.warning).toContainText("Animation plays at 00:00:06:00");
  await expect(p.toast).toContainText("Title's animation stayed");
  await page.screenshot({ path: info.outputPath("shared-move.png") });
  await p.select("still");
  await expect(p.warning).toHaveCount(0);
  await p.select("title");
  await afterPaint(page, () =>
    page.getByRole("button", { name: "Undo", exact: true }).click(),
  );
  await p.silent();
  await page.screenshot({ path: info.outputPath("undo-restored.png") });
  await afterPaint(page, () =>
    page.getByRole("button", { name: "Redo", exact: true }).click(),
  );
  await expect(p.warning).toBeVisible();
  await expect(p.toast).toBeVisible();
});

test("move then undo restores the finite animation without a second toast", async ({
  page,
  request,
}) => {
  const p = await open(page, request, {
    script: `${rootTimeline}tl.to('.one',{x:100,duration:.5},6);`,
  });
  await p.select("title");
  await p.edit([{ type: "move", clipIds: ["title"], by: 60 }]);
  await expect(p.toast).toBeVisible();
  await afterPaint(page, () =>
    page.getByRole("button", { name: "Undo", exact: true }).click(),
  );
  await p.silent();
});

for (const edge of ["start", "end"] as const) {
  test(`finite animation ${edge} trim stays silent`, async ({
    page,
    request,
  }) => {
    const p = await open(page, request, {
      script: `${rootTimeline}tl.to('.one',{x:100,duration:3},6);`,
    });
    await p.select("title");
    await p.edit([
      { type: "trim", clipId: "title", edge, to: edge === "start" ? 210 : 220 },
    ]);
    await p.silent();
  });
}

for (const delayed of ["registration", "construction"]) {
  test(`700 ms delayed timeline ${delayed} is seen after a move`, async ({
    page,
    request,
  }) => {
    const tween = `tl.fromTo('.one',{opacity:0},{opacity:1,duration:.5},6);`;
    const script =
      delayed === "registration"
        ? `setTimeout(()=>{${rootTimeline}${tween}},700);`
        : `${rootTimeline}setTimeout(()=>{${tween}},700);`;
    const p = await open(page, request, { script });
    await p.select("title");
    await p.edit([{ type: "move", clipIds: ["title"], by: 60 }]);
    await expect(p.warning).toBeVisible();
    await expect(p.toast).toContainText("Title's animation stayed");
  });
}

test("head trim, tail trim and an infinite repeat stay silent; a later move still warns", async ({
  page,
  request,
}) => {
  const p = await open(page, request, {
    script: `${rootTimeline}tl.to('.one',{x:100,duration:1,repeat:-1,yoyo:true},6);`,
  });
  await p.select("title");
  await p.silent();
  await p.edit([{ type: "trim", clipId: "title", edge: "start", to: 210 }]);
  await p.silent();
  await p.edit([{ type: "trim", clipId: "title", edge: "end", to: 220 }]);
  await p.silent();
  await p.edit([{ type: "move", clipIds: ["title"], by: 60 }]);
  await expect(p.warning).toBeVisible();
});

test("razor and paste compare shared class targets with their source clips", async ({
  page,
  request,
}) => {
  const p = await open(page, request, {
    script: `${rootTimeline}tl.fromTo('.one',{opacity:0},{opacity:1,duration:.5},6);`,
  });
  await p.edit([{ type: "split", at: 240, clipIds: ["title"] }]);
  const right = (await p.read()).timeline.clips.find(
    (clip) => clip.start === 240,
  )!;
  await p.select(right.id);
  await p.silent();
  await p.edit([{ type: "move", clipIds: [right.id], by: 180 }]);
  await expect(p.warning).toBeVisible();
  await p.select("title");
  await expect(p.warning).toHaveCount(0);
  const before = await p.read();
  const clipboard = await (
    await request.post(`${p.base}/timeline/copy`, {
      data: {
        composition: "index.html",
        expectedRevision: before.revision,
        clipIds: ["title"],
      },
    })
  ).json();
  await p.edit([
    { type: "paste", clipboardId: clipboard.id, at: 600, mode: "insert" },
  ]);
  const pasted = (await p.read()).timeline.clips.find(
    (clip) => clip.start === 600,
  )!;
  await p.select(pasted.id);
  await expect(p.warning).toBeVisible();
});

test("source fixes clear warnings, and the next move is checked independently", async ({
  page,
  request,
}) => {
  const p = await open(page, request, {
    script: `${rootTimeline}tl.to('.one',{x:100,duration:.5},6);`,
  });
  await p.select("title");
  await p.edit([{ type: "move", clipIds: ["title"], by: 60 }]);
  await expect(p.warning).toBeVisible();
  const source = await (await request.get(`${p.base}/source`)).json();
  await afterPaint(page, async () => {
    const result = await request.put(`${p.base}/source`, {
      data: {
        path: "index.html",
        expectedVersion: source.version,
        content: source.content.replace("duration:.5},6)", "duration:.5},8)"),
      },
    });
    expect(result.ok()).toBe(true);
  });
  await p.silent();
  await p.edit([{ type: "move", clipIds: ["title"], by: 60 }]);
  await expect(p.warning).toBeVisible();
  await writeFile(
    join(p.project.path, "timing.js"),
    `${rootTimeline}tl.to('.one',{x:100,duration:.5},10);`,
  );
  await afterPaint(page, async () => {
    const html = await readFile(join(p.project.path, "index.html"), "utf8");
    await writeFile(
      join(p.project.path, "index.html"),
      html.replace(
        /<script>[\s\S]*<\/script>/,
        '<script src="timing.js"></script>',
      ),
    );
  });
  await p.silent();
  await p.edit([{ type: "move", clipIds: ["title"], by: 60 }]);
  await expect(p.warning).toBeVisible();
  await afterPaint(page, () =>
    writeFile(
      join(p.project.path, "timing.js"),
      `${rootTimeline}tl.to('.one',{x:100,duration:.5},12);`,
    ),
  );
  await p.silent();
});

for (const fixture of [
  "absolute",
  "dom-read",
  "inline-composition",
  "sub-composition-outro",
  "sub-composition",
]) {
  test(`${fixture} design fixture preserves its authored timing model through edits`, async ({
    page,
    request,
  }) => {
    const p = await open(page, request, { fixture });
    const id = fixture === "sub-composition-outro" ? "lower" : "cta";
    await p.select(id);
    if (fixture === "absolute" || fixture === "dom-read") {
      await writeFile(
        join(p.project.path, "insert.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="blue"/></svg>',
      );
      await p.edit([
        {
          type: "insert",
          at: 0,
          track: 0,
          mode: "insert",
          clip: { kind: "image", src: "insert.svg", duration: 60 },
        },
      ]);
      if (fixture === "absolute") await expect(p.warning).toBeVisible();
      else await p.silent();
    }
    await p.edit([{ type: "move", clipIds: [id], by: -60 }]);
    if (fixture === "absolute") {
      await p.silent();
      return;
    }
    await p.silent();
    if (fixture === "dom-read") return;
    const clip = (await p.read()).timeline.clips.find(
      (clip) => clip.id === id,
    )!;
    await p.edit([
      { type: "trim", clipId: id, edge: "start", to: clip.start + 30 },
    ]);
    await p.silent();
    await p.edit([
      {
        type: "trim",
        clipId: id,
        edge: "end",
        to: clip.start + clip.duration - 15,
      },
    ]);
    await p.silent();
    if (!fixture.startsWith("sub-composition")) return;
    const current = (await p.read()).timeline.clips.find(
      (clip) => clip.id === id,
    )!;
    await p.edit([{ type: "split", clipIds: [id], at: current.start + 15 }]);
    await p.silent();
    const before = await p.read();
    const clipboard = await (
      await request.post(`${p.base}/timeline/copy`, {
        data: {
          composition: "index.html",
          expectedRevision: before.revision,
          clipIds: [id],
        },
      })
    ).json();
    await p.edit([
      { type: "paste", clipboardId: clipboard.id, at: 1260, mode: "insert" },
    ]);
    await p.silent();
    await afterPaint(page, () =>
      page.getByRole("button", { name: "Undo", exact: true }).click(),
    );
    await p.silent();
    await afterPaint(page, () =>
      page.getByRole("button", { name: "Redo", exact: true }).click(),
    );
    await p.silent();
  });
}

test("500 clips and 10000 tweens produce an indexed compact report", async ({
  page,
  request,
}, info) => {
  const clips = Array.from(
    { length: 500 },
    (_, i) =>
      `<div id="c${i}" data-start="${i / 10}" data-duration="1" data-track-index="${i % 10}">${i}</div>`,
  ).join("");
  const script = `${rootTimeline}for(let i=0;i<500;i++)for(let j=0;j<20;j++)tl.to('#c'+i,{x:j,duration:.01},i/10+j*.02);`;
  const p = await open(page, request, { script: "" });
  await afterPaint(page, () =>
    writeFile(
      join(p.project.path, "index.html"),
      document(script).replace(
        /<div id="title"[\s\S]*<\/main>/,
        `${clips}</main>`,
      ),
    ),
  );
  const bridge = await readFile(
    "src/server/hyperframes/previewBridge.ts",
    "utf8",
  );
  const source = bridge.slice(
    bridge.indexOf("function animationWindows("),
    bridge.indexOf("/** Runs inside the opaque preview."),
  );
  const compiled = spawnSync(
    "bun",
    [
      "-e",
      'process.stdout.write(new Bun.Transpiler({loader:"ts"}).transformSync(await Bun.stdin.text()))',
    ],
    { input: source, encoding: "utf8" },
  );
  expect(compiled.status, compiled.stderr).toBe(0);
  const measurement = await page
    .frameLocator("iframe[data-live]")
    .locator("main")
    .evaluate((root, compiled) => {
      const read = new Function(`${compiled};return animationWindows;`)();
      const times: number[] = [];
      let result: Record<string, [string, number[]][]> = {};
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        result = read(root, Reflect.get(window, "__timelines"));
        times.push(performance.now() - start);
      }
      return {
        times,
        bytes: JSON.stringify({
          source: "cutroom-preview",
          type: "animation-windows",
          windows: result,
        }).length,
        clips: Object.keys(result).length,
        tweens: Object.values(result).reduce(
          (n, values) =>
            n + values.reduce((sum, [, starts]) => sum + starts.length, 0),
          0,
        ),
      };
    }, compiled.stdout);
  console.log("animation report", measurement);
  await writeFile(
    info.outputPath("animation-report.json"),
    JSON.stringify(measurement, null, 2),
  );
  expect(measurement.clips).toBe(500);
  expect(measurement.tweens).toBe(10000);
  expect(measurement.times.toSorted((a, b) => a - b)[2]).toBeLessThan(10);
  expect(measurement.bytes).toBeLessThan(300000);
});
