import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { APIRequestContext, Page, TestInfo } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import type { CommandInput } from "../src/shared/timeline/schema";
import { interviewWorkload } from "../scripts/interview-performance";
import { afterPaint, seekFrame } from "./position-helpers";
import { expect, test } from "./fixtures";

const live = (page: Page) =>
  page.locator("iframe[data-live]").getAttribute("src");
const ready = (page: Page) =>
  expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();

const eligible = (page: Page) =>
  expect(page.locator(".edit-stage")).toHaveAttribute(
    "data-preview-timing-ready",
    "true",
  );

async function fixture(request: APIRequestContext, page: Page, script = "") {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Live title", width: 640, height: 360, duration: 10 },
      })
    ).json(),
  );
  await copyFile(
    "src/client/fonts/MartianMono-var.woff2",
    join(project.path, "assets/fonts/Mono.woff2"),
  );
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><style>
    @font-face{font-family:"Instrument Sans";src:url(assets/fonts/InstrumentSans-var.woff2);font-weight:400 700}
    @font-face{font-family:Mono;src:url(assets/fonts/Mono.woff2);font-weight:400 700}
    html,body{margin:0;background:#111}main{position:relative;width:640px;height:360px}
    </style></head><body><main id="main" data-composition-id="main" data-width="640" data-height="360" data-fps="30" data-duration="10"><div id="background" class="clip" data-start="0" data-duration="10" data-track-index="0" style="position:absolute;inset:0;background:#111"></div></main>${script}</body></html>`,
  );
  const path = `/api/cutroom/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${path}/timeline`)).json(),
    );
  const edit = async (commands: CommandInput[]) => {
    const response = await request.post(`${path}/commands`, {
      data: {
        composition: "index.html",
        expectedRevision: (await read()).revision,
        label: "Title test",
        commands,
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
  };
  await edit([
    {
      type: "insert",
      track: 1,
      at: 30,
      clip: {
        kind: "title",
        id: "lower",
        text: "Ada Lovelace\nFounder",
        duration: 120,
        title: { size: 32, font: "Instrument Sans" },
      },
    },
  ]);
  await page.goto(`/#project/${project.id}`);
  await ready(page);
  if (!script) await eligible(page);
  await page.locator('[data-clip="lower"]').click();
  await seekFrame(page, 90);
  return { project, path, edit, read };
}

/** Wait for the bridge's actual seek and paint, including its opaque video holds. */
async function paint(page: Page) {
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

async function parity(
  page: Page,
  fresh: Page,
  projectId: string,
  frames: number[],
  label: string,
  info: TestInfo,
) {
  // One untouched document compiled after the edit, observed at each requested frame.
  await fresh.goto(`/#project/${projectId}`);
  await ready(fresh);
  await fresh.locator('[data-clip="lower"]').click();
  for (const frame of frames) {
    await page.locator('[data-clip="lower"]').click();
    await seekFrame(page, frame);
    await paint(page);
    await seekFrame(fresh, frame);
    await paint(fresh);
    const patched = await page.locator("iframe[data-live]").screenshot();
    const loaded = await fresh.locator("iframe[data-live]").screenshot();
    if (!patched.equals(loaded)) {
      const rendered = (tab: Page) =>
        tab
          .locator("iframe[data-live]")
          .contentFrame()
          .locator("#lower")
          .evaluate((element) => ({
            box: element.getBoundingClientRect().toJSON(),
            font: getComputedStyle(element).font,
            transform: getComputedStyle(element).transform,
            opacity: getComputedStyle(element).opacity,
            animations: element.getAnimations().map((animation) => ({
              name:
                animation instanceof CSSAnimation
                  ? animation.animationName
                  : null,
              time: animation.currentTime,
              state: animation.playState,
              timing: animation.effect?.getComputedTiming(),
            })),
          }));
      await info.attach(`${label}-${frame}-state.json`, {
        body: JSON.stringify(
          {
            live: await rendered(page),
            fresh: await rendered(fresh),
            outer: await Promise.all(
              [page, fresh].map((tab) =>
                tab.locator("iframe[data-live]").evaluate((element) => ({
                  box: element.getBoundingClientRect().toJSON(),
                  transform: getComputedStyle(element).transform,
                  origin: getComputedStyle(element).transformOrigin,
                  picture: element.parentElement
                    ?.getBoundingClientRect()
                    .toJSON(),
                  ratio: devicePixelRatio,
                })),
              ),
            ),
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
    }
    if (!patched.equals(loaded) || label === "text") {
      await writeFile(info.outputPath(`${label}-${frame}-live.png`), patched);
      await writeFile(info.outputPath(`${label}-${frame}-fresh.png`), loaded);
      await info.attach(`${label}-${frame}-live.png`, {
        body: patched,
        contentType: "image/png",
      });
      await info.attach(`${label}-${frame}-fresh.png`, {
        body: loaded,
        contentType: "image/png",
      });
    }
    expect(patched.equals(loaded), `${label}, frame ${frame}`).toBe(true);
    const animations = (tab: Page) =>
      tab
        .locator("iframe[data-live]")
        .contentFrame()
        .locator("#lower")
        .evaluate((element) => element.getAnimations().length);
    expect(
      await animations(page),
      `${label}, retained animation handles at ${frame}`,
    ).toBe(await animations(fresh));
  }
  // Close the comparison document's SSE connection before the next edit.
  await fresh.goto("about:blank");
}

test("inspector title controls and supported motion retain the paused document and match fresh PNGs", async ({
  page,
  request,
}, info) => {
  test.setTimeout(300000);
  const { project, edit } = await fixture(request, page);
  const original = await live(page);
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const fresh = await page.context().newPage();
  const choose = async (menu: string, value: string) => {
    await inspector.getByRole("combobox", { name: menu, exact: true }).click();
    await page.getByRole("option", { name: value, exact: true }).click();
  };
  const type = async (field: string, value: string) => {
    const input = inspector.getByRole("textbox", { name: field, exact: true });
    await input.fill(value);
    await input.press("Enter");
  };
  const changes: [string, () => Promise<unknown>][] = [
    ["size", () => type("Size", "42")],
    ["weight", () => choose("Weight", "Bold")],
    ["colour hex", () => type("Colour hex", "ffcc00")],
    [
      "colour picker",
      () => inspector.getByLabel("Colour", { exact: true }).fill("#00ff88"),
    ],
    [
      "alignment",
      () => inspector.getByRole("radio", { name: "Align centre" }).click(),
    ],
    ["position", () => choose("Position", "Top")],
    ["plate", () => inspector.getByRole("checkbox", { name: "Plate" }).check()],
    ["plate colour", () => type("Plate colour hex", "ffffff")],
    [
      "plate picker",
      () =>
        inspector.getByLabel("Plate colour", { exact: true }).fill("#442266"),
    ],
    ["plate opacity", () => type("Plate opacity", "45")],
    [
      "shadow",
      () => inspector.getByRole("checkbox", { name: "Shadow" }).check(),
    ],
    ["shadow colour", () => type("Shadow colour hex", "2244ff")],
    ["shadow opacity", () => type("Shadow opacity", "90")],
    ["shadow blur", () => type("Blur", "4")],
    [
      "stroke",
      () => inspector.getByRole("checkbox", { name: "Stroke" }).check(),
    ],
    ["stroke colour", () => type("Stroke colour hex", "ff2200")],
    ["stroke width", () => type("Width", "2")],
    ["font", () => choose("Font", "Mono")],
    ["default font", () => choose("Font", "Default")],
    ["entrance", () => choose("In preset", "Slide")],
    ["entrance length", () => type("In", "20f")],
    ["exit", () => choose("Out preset", "Wipe")],
    ["exit length", () => type("Out", "20f")],
    [
      "remove plate",
      () => inspector.getByRole("checkbox", { name: "Plate" }).uncheck(),
    ],
    [
      "remove shadow",
      () => inspector.getByRole("checkbox", { name: "Shadow" }).uncheck(),
    ],
    [
      "remove stroke",
      () => inspector.getByRole("checkbox", { name: "Stroke" }).uncheck(),
    ],
    [
      "text",
      async () => {
        const field = inspector.getByRole("textbox", {
          name: "Text",
          exact: true,
        });
        await field.fill('Ada & <b>words</b>\n"Founder"\n</script>');
        await field.press("Enter");
      },
    ],
  ];
  try {
    for (const [name, change] of changes) {
      await afterPaint(page, change);
      expect(await live(page), name).toBe(original);
      await parity(page, fresh, project.id, [32, 90, 148], name, info);
    }
    const shown = page
      .locator("iframe[data-live]")
      .contentFrame()
      .locator("#lower");
    await expect(shown.locator("b, script")).toHaveCount(0);
    await expect(shown.locator("br")).toHaveCount(2);
    for (const preset of ["none", "fade", "wipe", "slide"] as const) {
      await afterPaint(page, () =>
        edit([
          {
            type: "setClip",
            clipId: "lower",
            title: {
              in: { preset, frames: 90 },
              out: { preset, frames: 90 },
            },
          },
        ]),
      );
      expect(await live(page)).toBe(original);
      await parity(page, fresh, project.id, [32, 90, 148], preset, info);
    }
    for (const name of ["Undo", "Redo"]) {
      await afterPaint(page, () =>
        page.getByRole("button", { name, exact: true }).click(),
      );
      expect(await live(page)).toBe(original);
      await parity(page, fresh, project.id, [32, 90, 148], name, info);
    }
    await afterPaint(page, () =>
      edit([
        { type: "move", clipIds: ["lower"], by: 1, mode: "overwrite" },
        { type: "trim", clipId: "lower", edge: "end", to: 145, ripple: false },
      ]),
    );
    expect(await live(page)).toBe(original);
    await parity(page, fresh, project.id, [31, 90, 144, 145], "timing", info);
  } finally {
    await fresh.close();
  }
});

test("loaded Scale titles reload font, size, plate and words from the saved document", async ({
  page,
  request,
}) => {
  const { edit } = await fixture(request, page);
  await afterPaint(page, () =>
    edit([
      {
        type: "setClip",
        clipId: "lower",
        title: { in: { preset: "scale" }, out: { preset: "scale" } },
      },
    ]),
  );
  await page.reload();
  await ready(page);
  await seekFrame(page, 90);
  const changes: CommandInput[] = [
    { type: "setClip", clipId: "lower", title: { font: "Mono" } },
    { type: "setClip", clipId: "lower", title: { size: 42 } },
    { type: "setClip", clipId: "lower", title: { plate: "#77442299" } },
    { type: "setClip", clipId: "lower", text: "Changed & owner\nSecond line" },
  ];
  for (const command of changes) {
    await eligible(page);
    const original = await live(page);
    await afterPaint(page, () => edit([command]));
    expect(await live(page)).not.toBe(original);
  }
  const title = page
    .locator("iframe[data-live]")
    .contentFrame()
    .locator("#lower");
  await expect(title).toHaveAttribute("data-title-font", "Mono");
  await expect(title).toHaveAttribute("data-title-size", "42px");
  await expect(title).toHaveAttribute("data-title-plate", "#77442299");
  await expect(title).toHaveAttribute("data-title-in", "scale");
  await expect(title).toHaveAttribute("data-title-out", "scale");
  expect(await title.innerText()).toBe("Changed & owner\nSecond line");
});

test("MCP title edits and history update both tabs through the same revisioned live operation", async ({
  page,
  request,
  baseURL,
}, info) => {
  test.setTimeout(120000);
  const { project, read } = await fixture(request, page);
  const second = await page.context().newPage();
  const fresh = await page.context().newPage();
  await second.goto(`/#project/${project.id}`);
  await ready(second);
  await eligible(second);
  await seekFrame(second, 90);
  const originals = await Promise.all([live(page), live(second)]);
  const client = new Client({ name: "live-title-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
      requestInit: { headers: { origin: baseURL! } },
    }),
  );
  try {
    const tokens = await Promise.all(
      [page, second].map((tab) =>
        tab.locator(".edit-stage").getAttribute("data-preview-ready"),
      ),
    );
    const result = await client.callTool({
      name: "timeline_edit",
      arguments: {
        projectId: project.id,
        composition: "index.html",
        expectedRevision: (await read()).revision,
        label: "Agent title",
        commands: [
          {
            type: "setClip",
            clipId: "lower",
            text: "Agent & owner\nSecond line",
            title: {
              font: "Mono",
              plate: "#77442299",
            },
          },
        ],
      },
    });
    expect(result.isError).not.toBe(true);
    for (const [i, tab] of [page, second].entries()) {
      await expect(
        tab.locator(".edit-stage[data-preview-ready]"),
      ).not.toHaveAttribute("data-preview-ready", tokens[i]!);
      await ready(tab);
      expect(await live(tab)).toBe(originals[i]);
      await parity(tab, fresh, project.id, [32, 90, 148], "MCP", info);
    }
    for (const name of ["Undo", "Redo"]) {
      const old = await second
        .locator(".edit-stage")
        .getAttribute("data-preview-ready");
      await afterPaint(page, () =>
        page.getByRole("button", { name, exact: true }).click(),
      );
      await expect(
        second.locator(".edit-stage[data-preview-ready]"),
      ).not.toHaveAttribute("data-preview-ready", old!);
      for (const [i, tab] of [page, second].entries()) {
        await ready(tab);
        expect(await live(tab)).toBe(originals[i]);
        await parity(tab, fresh, project.id, [32, 90, 148], name, info);
      }
    }
  } finally {
    await client.close();
    await second.close();
    await fresh.close();
  }
});

test("title edits share the timing operation with track gains and linked source timing", async ({
  page,
  request,
}) => {
  const project = await interviewWorkload(request);
  const path = `/api/cutroom/projects/${project.id}`;
  const edit = async (commands: CommandInput[]) => {
    const view = TimelineViewSchema.parse(
      await (await request.get(`${path}/timeline`)).json(),
    );
    const response = await request.post(`${path}/commands`, {
      data: {
        composition: "index.html",
        expectedRevision: view.revision,
        label: "Title and gain",
        commands,
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
  };
  await edit([{ type: "setTrack", index: 1, volume: 0.5 }]);
  await page.goto(`/#project/${project.id}`);
  await ready(page);
  await eligible(page);
  await seekFrame(page, 90);
  const original = await live(page);
  const frame = page.locator("iframe[data-live]").contentFrame();
  const bus = frame.locator('hf-audio-group[data-cutroom-track="1"]');
  await expect(bus).toHaveAttribute("data-volume", "0.5");
  await afterPaint(page, () =>
    edit([
      {
        type: "setClip",
        clipId: "title-0",
        text: "Mixed & title",
        title: { size: 80, plate: "#11223399" },
      },
      { type: "setTiming", clipId: "voice-0", mediaStart: 0.25 },
      { type: "setTrack", index: 1, volume: 0.25 },
    ]),
  );
  expect(await live(page)).toBe(original);
  await expect(frame.locator("#title-0")).toHaveAttribute(
    "data-title-size",
    "80px",
  );
  await expect(frame.locator("#title-0")).toHaveText("Mixed & title");
  await expect(frame.locator("#voice-0")).toHaveAttribute(
    "data-media-start",
    "0.25",
  );
  await expect(bus).toHaveAttribute("data-volume", "0.25");
  await afterPaint(page, () =>
    edit([{ type: "setTrack", index: 1, volume: 0.75 }]),
  );
  expect(await live(page)).toBe(original);
  await expect(bus).toHaveAttribute("data-volume", "0.75");
  await afterPaint(page, () =>
    edit([
      {
        type: "setClip",
        clipId: "title-0",
        text: "Next words",
        title: { color: "#ffcc00" },
      },
    ]),
  );
  expect(await live(page)).toBe(original);
  await expect(frame.locator("#title-0")).toHaveText("Next words");
  await expect(bus).toHaveAttribute("data-volume", "0.75");
});

for (const failure of [
  "script",
  "DOM",
  "CSS",
  "discovery",
  "seek style",
  "seek attribute",
  "scale",
] as const)
  test(`title ${failure} uncertainty falls back to the saved document`, async ({
    page,
    request,
  }) => {
    const { project, edit } = await fixture(
      request,
      page,
      // A script that found the title may have built from its words when it loaded.
      failure === "script"
        ? "<script>window.lower=document.querySelector('#lower')</script>"
        : "",
    );
    if (failure === "discovery") {
      await afterPaint(page, () =>
        edit([
          {
            type: "setClip",
            clipId: "lower",
            title: { in: { preset: "none" }, out: { preset: "none" } },
          },
        ]),
      );
      await page.reload();
      await ready(page);
    }
    const original = await live(page);
    if (failure === "DOM")
      await page
        .locator("iframe[data-live]")
        .contentFrame()
        .locator("#lower")
        .evaluate((element) => {
          element.textContent = "Divergent";
        });
    if (failure === "seek style" || failure === "seek attribute") {
      await page
        .locator("iframe[data-live]")
        .contentFrame()
        .locator("#lower")
        .evaluate((element, failure) => {
          if (failure === "seek style")
            (element as HTMLElement).style.background = "red";
          else element.setAttribute("data-hf-clip-hidden", "outside");
        }, failure);
      await seekFrame(page, 32);
      await paint(page);
    }
    if (failure === "CSS") {
      const path = join(project.path, "index.html");
      await afterPaint(page, () =>
        readFile(path, "utf8").then((html) =>
          writeFile(path, html.replace("line-height:1.15", "line-height:2")),
        ),
      );
    }
    await afterPaint(page, () =>
      edit([
        {
          type: "setClip",
          clipId: "lower",
          text: "Saved words",
          title: {
            size: 48,
            in: { preset: failure === "scale" ? "scale" : "slide" },
            ...(failure === "scale"
              ? { font: "Mono", out: { preset: "slide" as const } }
              : {}),
          },
        },
      ]),
    );
    expect(await live(page)).not.toBe(original);
    await expect(
      page.locator("iframe[data-live]").contentFrame().locator("#lower"),
    ).toHaveText("Saved words");
  });
