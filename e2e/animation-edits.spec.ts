import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { afterPaint } from "./position-helpers";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import type { CommandInput } from "../src/shared/timeline/schema";

const root =
  "const tl=gsap.timeline({paused:true});window.__timelines.main=tl;";
async function open(
  page: Page,
  request: APIRequestContext,
  script = "tl.to('.one',{x:100,duration:1},6);",
  settle = 800,
) {
  const project = await (
    await request.post("/api/cutroom/projects", {
      data: { name: "Animation edit regressions" },
    })
  ).json();
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><script src="gsap.min.js"></script><style>body{margin:0;background:#111;color:#eee;font:48px sans-serif}.one{position:absolute;top:80px;left:30px}</style></head><body><main data-composition-id="main" data-width="640" data-height="360" data-duration="48" data-fps="30"><div id="title" class="clip one" data-label="Title" data-start="6" data-duration="4" data-track-index="1">Title</div></main><script>${root}${script}</script></body></html>`,
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
  await page.waitForTimeout(settle);
  const base = `/api/cutroom/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${base}/timeline`)).json(),
    );
  const edit = async (commands: CommandInput[]) =>
    afterPaint(page, async () => {
      const before = await read();
      const response = await request.post(`${base}/commands`, {
        data: {
          composition: "index.html",
          expectedRevision: before.revision,
          commands,
        },
      });
      expect(response.ok(), await response.text()).toBe(true);
    });
  const source = async (replace: (s: string) => string) =>
    afterPaint(page, async () => {
      const before = await (await request.get(`${base}/source`)).json();
      const response = await request.put(`${base}/source`, {
        data: {
          path: "index.html",
          expectedVersion: before.version,
          content: replace(before.content),
        },
      });
      expect(response.ok(), await response.text()).toBe(true);
    });
  const select = (id = "title") => page.locator(`[data-clip="${id}"]`).click();
  const warning = page.locator(".inspector-timing .inspector-warning");
  const history = async (name: "Undo" | "Redo") =>
    afterPaint(page, () =>
      page.getByRole("button", { name, exact: true }).click(),
    );
  const silent = async () => {
    await page.waitForTimeout(700);
    await expect(warning).toHaveCount(0);
  };
  return {
    project,
    base,
    read,
    edit,
    source,
    select,
    warning,
    history,
    silent,
  };
}

test("R3 #1 media rename remains writable after animation observation", async ({
  page,
  request,
}) => {
  const p = await open(page, request);
  await writeFile(
    join(p.project.path, "picture.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
  );
  await p.edit([{ type: "move", clipIds: ["title"], by: 60 }]);
  await p.select();
  await expect(p.warning).toBeVisible();
  const response = await request.patch(
    `/api/projects/${p.project.id}/files/picture.svg`,
    { data: { newPath: "renamed.svg" } },
  );
  expect(response.ok(), await response.text()).toBe(true);
});

test("R3 #2 end trim cannot swap tween identities; the next move is checked", async ({
  page,
  request,
}) => {
  const p = await open(
    page,
    request,
    "const c=document.querySelector('.one');tl.to(c,{x:100,duration:+c.dataset.duration},6);tl.to(c,{x:200,duration:2},7);",
  );
  await p.select();
  await p.edit([{ type: "trim", clipId: "title", edge: "end", to: 240 }]);
  await p.silent();
  await p.edit([{ type: "move", clipIds: ["title"], by: 60 }]);
  await expect(p.warning).toBeVisible();
});

test("R3 #3 undoing a clean source edit cannot create a move warning", async ({
  page,
  request,
}) => {
  const p = await open(page, request);
  await p.select();
  await p.source((s) => s.replace("duration:1},6)", "duration:1},7)"));
  await p.silent();
  await p.history("Undo");
  await p.silent();
});

test("R3 #4 delete then undo retains enough evidence for the next move", async ({
  page,
  request,
}) => {
  const p = await open(page, request);
  await p.edit([{ type: "remove", clipIds: ["title"], ripple: false }]);
  await page.waitForTimeout(400);
  await p.history("Undo");
  await page.waitForTimeout(500);
  await p.select();
  await p.edit([{ type: "move", clipIds: ["title"], by: 60 }]);
  await expect(p.warning).toBeVisible();
});

test("R3 #4 copy delete paste checks the saved clipboard report", async ({
  page,
  request,
}) => {
  const p = await open(page, request);
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
  await p.edit([{ type: "remove", clipIds: ["title"], ripple: false }]);
  await page.waitForTimeout(400);
  await p.edit([
    { type: "paste", clipboardId: clipboard.id, at: 600, mode: "insert" },
  ]);
  const pasted = (await p.read()).timeline.clips[0]!;
  await p.select(pasted.id);
  await expect(p.warning).toBeVisible();
});

test("R3 #5 an unrelated HTML file cannot certify a broken move", async ({
  page,
  request,
}) => {
  const p = await open(page, request);
  await p.select();
  await p.edit([{ type: "move", clipIds: ["title"], by: 60 }]);
  await expect(p.warning).toBeVisible();
  await writeFile(
    join(p.project.path, "unrelated.html"),
    "<main>Unrelated</main>",
  );
  await page.reload();
  await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
  await p.select();
  await page.waitForTimeout(700);
  await expect(p.warning).toBeVisible();
});

test("R3 #6 incremental construction does not queue reports ahead of inspector Start", async ({
  page,
  request,
}, info) => {
  const p = await open(
    page,
    request,
    "let n=0;setTimeout(()=>{const timer=setInterval(()=>{tl.to('.one',{x:n,duration:1},6+n/20);if(++n===40)clearInterval(timer)},10)},150);",
    650,
  );
  await p.select();
  const start = page.getByRole("textbox", { name: "Start", exact: true });
  await start.fill("8s");
  const receipt = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/commands"),
  );
  const begin = performance.now();
  await start.press("Enter");
  const response = await receipt;
  expect(response.ok(), await response.text()).toBe(true);
  const milliseconds = performance.now() - begin;
  console.log(`inspector incremental Start: ${milliseconds.toFixed(1)} ms`);
  await info.attach("inspector-latency", {
    body: JSON.stringify({ milliseconds }),
    contentType: "application/json",
  });
  expect(milliseconds).toBeLessThan(1500);
  await expect
    .poll(async () => (await p.read()).timeline.clips[0]!.start)
    .toBe(240);
});

test("R3 #7 a timed zero-duration set warns; a callback stays silent", async ({
  page,
  request,
}) => {
  const p = await open(
    page,
    request,
    "tl.set('.one',{opacity:0},6);tl.call(()=>{},[],7);",
  );
  await p.select();
  await p.edit([{ type: "move", clipIds: ["title"], by: 60 }]);
  await expect(p.warning).toBeVisible();
});

test("a source fix clears the warning and undo restores the edit's saved result", async ({
  page,
  request,
}) => {
  const p = await open(page, request);
  await p.select();
  await p.edit([{ type: "move", clipIds: ["title"], by: 60 }]);
  await expect(p.warning).toBeVisible();
  await p.source((s) => s.replace("duration:1},6)", "duration:1},8)"));
  await p.silent();
  await p.history("Undo");
  await expect(p.warning).toBeVisible();
  await p.history("Redo");
  await p.silent();
});

test("two moves then returning to the original origin clears the warning", async ({
  page,
  request,
}) => {
  const p = await open(page, request);
  await p.select();
  await p.edit([{ type: "move", clipIds: ["title"], by: 60 }]);
  await expect(p.warning).toBeVisible();
  await p.edit([{ type: "move", clipIds: ["title"], by: 60 }]);
  await expect(p.warning).toBeVisible();
  await p.edit([{ type: "move", clipIds: ["title"], by: -120 }]);
  await p.silent();
});

test("MCP moves use the same edit-scoped warning as the inspector", async ({
  page,
  request,
  baseURL,
}) => {
  const p = await open(page, request);
  await p.select();
  const client = new Client({ name: "animation-edit-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
      requestInit: { headers: { origin: new URL(baseURL!).origin } },
    }),
  );
  try {
    const before = await p.read();
    await afterPaint(page, async () => {
      const result = await client.callTool({
        name: "timeline_edit",
        arguments: {
          projectId: p.project.id,
          composition: "index.html",
          expectedRevision: before.revision,
          commands: [{ type: "move", clipIds: ["title"], by: 60 }],
        },
      });
      expect(result.isError).not.toBe(true);
    });
    await expect(p.warning).toBeVisible();
  } finally {
    await client.close();
  }
});

for (const local of [false, true]) {
  test(`playback rate origin change ${local ? "excludes a registered child timeline" : "checks root animation"}`, async ({
    page,
    request,
  }) => {
    const script = local
      ? "window.__timelines.title=gsap.timeline({paused:true}).to('.one',{x:100,duration:1},0);"
      : undefined;
    const p = await open(page, request, script);
    await p.source((s) =>
      s.replace(
        'id="title"',
        'id="title" data-composition-id="title" data-media-start="2" data-playback-rate="2"',
      ),
    );
    await page.waitForTimeout(500);
    await p.select();
    await p.edit([{ type: "setTiming", clipId: "title", playbackRate: 1 }]);
    if (local) await p.silent();
    else await expect(p.warning).toBeVisible();
  });
}
