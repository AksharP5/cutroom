import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { afterPaint, seekFrame } from "./position-helpers";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import type { CommandInput } from "../src/shared/timeline/schema";
const root =
  "const tl=gsap.timeline({paused:true});window.__timelines.main=tl;";
function html(script: string, attrs = "") {
  return `<!doctype html><html><head><script src="gsap.min.js"></script><style>body{margin:0;background:#111;color:white;font:48px sans-serif}.clip{position:absolute;top:80px;left:30px}.still{top:180px}</style></head><body><main data-composition-id="main" data-width="640" data-height="360" data-duration="48" data-fps="30"><div id="title" class="clip one shared" data-start="6" data-duration="4" data-track-index="1" data-label="Title" ${attrs}>Title</div><div id="still" class="clip still shared" data-start="6" data-duration="4" data-track-index="2">Still</div></main><script>${script}</script></body></html>`;
}
async function open(
  page: Page,
  request: APIRequestContext,
  script: string,
  attrs = "",
  settle = 1600,
) {
  const project = await (
    await request.post("/api/cutroom/projects", {
      data: { name: "Animation baseline regressions" },
    })
  ).json();
  await writeFile(join(project.path, "index.html"), html(script, attrs));
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
  if (settle) await page.waitForTimeout(settle);
  const base = `/api/cutroom/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${base}/timeline`)).json(),
    );
  const command = async (commands: CommandInput[]) => {
    const before = await read();
    const r = await request.post(`${base}/commands`, {
      data: {
        composition: "index.html",
        expectedRevision: before.revision,
        commands,
      },
    });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const edit = async (commands: CommandInput[]) =>
    afterPaint(page, () => command(commands));
  const warning = page.locator(".inspector-timing .inspector-warning");
  const select = async (id: string) =>
    page.locator(`[data-clip="${id}"]`).click();
  const source = async (replace: (s: string) => string) => {
    const s = await (await request.get(`${base}/source`)).json();
    const r = await request.put(`${base}/source`, {
      data: {
        path: "index.html",
        expectedVersion: s.version,
        content: replace(s.content),
      },
    });
    expect(r.ok(), await r.text()).toBe(true);
  };
  return { command, edit, warning, select, source };
}

test("unobserved source then command stays unverified until a clean source revision", async ({
  page,
  request,
}) => {
  const p = await open(
    page,
    request,
    `${root}tl.to('.one',{x:100,duration:1},6);`,
  );
  await p.select("title");
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/isolated-preview?*", async (route) => {
    await gate;
    await route.continue().catch(() => {});
  });
  try {
    await p.source((s) => s.replace("duration:1},6)", "duration:1},7)"));
    await p.command([{ type: "move", clipIds: ["title"], by: 60 }]);
  } finally {
    release();
  }
  await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(p.warning).toHaveCount(0);
  await p.edit([{ type: "move", clipIds: ["title"], by: 30 }]);
  await page.waitForTimeout(700);
  await expect(p.warning).toHaveCount(0);
  await afterPaint(page, () =>
    p.source((s) => s.replace("duration:1},7)", "duration:1},9)")),
  );
  await page.waitForTimeout(700);
  await p.edit([{ type: "move", clipIds: ["title"], by: 30 }]);
  await expect(p.warning).toBeVisible();
});

test("a pair discovered after an early move never warns for a stationary clip", async ({
  page,
  request,
}) => {
  const p = await open(
    page,
    request,
    `${root}setTimeout(()=>tl.to('.shared',{x:100,duration:1},6),700);`,
    "",
    0,
  );
  await p.edit([{ type: "move", clipIds: ["title"], by: 60 }]);
  await page.waitForTimeout(2300);
  await p.select("still");
  await expect(p.warning).toHaveCount(0);
  await p.select("title");
  await expect(p.warning).toHaveCount(0);
  await p.edit([{ type: "move", clipIds: ["still"], by: 60 }]);
  await expect(p.warning).toHaveCount(0);
  await p.select("still");
  await expect(p.warning).toBeVisible();
});

test("reopening a broken move preserves its warning and undo clears it", async ({
  page,
  request,
}) => {
  const p = await open(
    page,
    request,
    `${root}tl.to('.one',{x:100,duration:1},6);`,
  );
  await p.select("title");
  await p.edit([{ type: "move", clipIds: ["title"], by: 60 }]);
  await expect(p.warning).toBeVisible();
  await page.reload();
  await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
  await p.select("title");
  await expect(p.warning).toBeVisible();
  await afterPaint(page, () =>
    page.getByRole("button", { name: "Undo", exact: true }).click(),
  );
  await expect(p.warning).toHaveCount(0);
});

test("a tween constructed after 1800ms is discovered without a sampling deadline", async ({
  page,
  request,
}) => {
  const p = await open(
    page,
    request,
    `${root}setTimeout(()=>tl.to('.one',{x:100,duration:1},6),1800);`,
    "",
    3000,
  );
  await p.select("title");
  await p.edit([{ type: "move", clipIds: ["title"], by: 60 }]);
  await expect(p.warning).toBeVisible();
});

test("crossing tween starts cannot hide two changed offsets", async ({
  page,
  request,
}, info) => {
  const script = `const tl=gsap.timeline({paused:true,sortChildren:true});window.__timelines.main=tl;const c=document.querySelector('.one');tl.to(c,{x:100,duration:1},+c.dataset.start + +c.dataset.duration - 4);tl.to(c,{y:100,duration:1},8);`;
  const p = await open(page, request, script);
  await p.select("title");
  await p.edit([
    { type: "move", clipIds: ["title"], by: 60 },
    { type: "trim", clipId: "title", edge: "end", to: 420 },
  ]);
  await expect(p.warning).toBeVisible();
  await seekFrame(page, 248);
  const transform = await page
    .frameLocator("iframe[data-live]")
    .locator("#title")
    .evaluate((el) => getComputedStyle(el).transform);
  expect(transform).not.toBe("none");
  await page.screenshot({ path: info.outputPath("crossing-tweens.png") });
});
