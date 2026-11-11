import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { test, expect } from "./fixtures";
import { ProjectSchema, SourceSchema } from "../src/shared/project";
import { ReviewItemSchema } from "../src/shared/review";
import { TimelineViewSchema } from "../src/shared/timeline/schema";

test("queue names stay whole and agent replies expand while MCP works a note", async ({
  page,
  request,
  baseURL,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Queue labels" },
      })
    ).json(),
  );
  const client = new Client({ name: "queue-agent", version: "1" });
  const result = z.object({
    structuredContent: z.object({ result: TimelineViewSchema }),
  });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
        requestInit: { headers: { Origin: baseURL! } },
      }),
    );
    await page.goto(`/#project/${project.id}`);
    await expect(
      page.frameLocator("iframe[data-live]").locator("#headline"),
    ).toHaveText("Queue labels");
    await page.locator('[data-clip="headline"]').click();
    await page.getByRole("button", { name: /^Comment/ }).click();
    await page
      .getByLabel("Pin a comment on the composition")
      .click({ position: { x: 400, y: 160 } });
    await page
      .getByLabel("What should change?")
      .fill("Give this title more room.");
    await page.getByLabel("What should change?").press("Enter");
    await page.getByRole("button", { name: "Review", exact: true }).click();
    const row = page
      .locator(".review-row")
      .filter({ hasText: "Give this title more room." });
    await expect(row.locator(".note-element")).toHaveText("Project title");
    const items = z
      .object({ items: z.array(ReviewItemSchema) })
      .parse(
        await (
          await request.get(`/api/cutroom/projects/${project.id}/review`)
        ).json(),
      ).items;
    const note = items[0]!;
    expect(note.elementId).toBe("headline");
    const call = async (name: string, args: Record<string, unknown>) => {
      const reply = await client.callTool({
        name,
        arguments: { projectId: project.id, ...args },
      });
      expect(reply.isError).not.toBe(true);
      return reply;
    };
    await call("review_claim", { noteId: note.id });
    const before = result.parse(await call("timeline_read", {}))
      .structuredContent.result;
    await call("timeline_edit", {
      noteId: note.id,
      expectedRevision: before.revision,
      commands: [
        {
          type: "setClip",
          clipId: "headline",
          label: "Opening title with room",
        },
      ],
    });
    const reply =
      "Raised the title and kept its spacing consistent through the intro. The caption stays clear of the rule at every frame. Please check the opening beat before accepting.";
    await call("review_complete", { noteId: note.id, note: reply });
    await expect(row.locator(".note-element")).toHaveText(
      "Opening title with room",
    );
    await page.mouse.move(1000, 80);
    const target = row.locator(".note-element");
    expect(
      await target.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    const summary = row.locator(".review-row-outcome p");
    expect(await summary.evaluate((element) => element.clientHeight)).toBe(34);
    await row.getByRole("button", { name: "More", exact: true }).click();
    expect(
      await summary.evaluate(
        (element) => element.scrollHeight === element.clientHeight,
      ),
    ).toBe(true);
    await expect(summary).toHaveText(reply);
    await row.getByRole("button", { name: "Less", exact: true }).click();
    // Space on the reply toggle reached by keyboard expands it instead of playing.
    const time = await page
      .getByRole("button", { name: /^Current time/ })
      .textContent();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(
      row.getByRole("button", { name: "More", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Space");
    await expect(
      row.getByRole("button", { name: "Less", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^Current time/ }),
    ).toHaveText(time!);
    await row.getByRole("button", { name: "Less", exact: true }).click();
    const accept = page.getByRole("button", {
      name: "Accept agent changes",
      exact: true,
    });
    const buttonBox = await accept.boundingBox();
    const headingBox = await page.locator(".review-summary").boundingBox();
    expect(buttonBox!.x - headingBox!.x).toBe(14);
    await page.reload();
    await page.getByRole("button", { name: "Review", exact: true }).click();
    await expect(row.locator(".note-element")).toHaveText(
      "Opening title with room",
    );
    await call("review_add", { body: "Keep the final frame.", time: 8 });
    const pictureNote = page
      .locator(".review-row")
      .filter({ hasText: "Keep the final frame." });
    await expect(pictureNote.locator(".note-element")).toHaveText("Picture");
    await expect(pictureNote.getByLabel("Frame unavailable")).toBeVisible();
    // A name too long for the row ends in an ellipsis on one line; the tooltip holds all of it.
    const long =
      "Opening_title_card_with_a_name_far_too_long_for_any_queue_row";
    const latest = result.parse(await call("timeline_read", {}))
      .structuredContent.result;
    await call("timeline_edit", {
      expectedRevision: latest.revision,
      commands: [{ type: "setClip", clipId: "headline", label: long }],
    });
    await expect(row.locator(".note-element")).toHaveAttribute("title", long);
    expect(
      await row
        .locator(".review-row-meta")
        .evaluate((meta) => meta.getBoundingClientRect().height),
    ).toBeLessThanOrEqual(18);
    expect(
      await row
        .locator(".note-element")
        .evaluate((name) => getComputedStyle(name).textOverflow),
    ).toBe("ellipsis");
  } finally {
    await client.close();
  }
});

test("marker names and token colours edit in place and remain readable through MCP and undo", async ({
  page,
  request,
  baseURL,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Ruler names" },
      })
    ).json(),
  );
  const client = new Client({ name: "marker-agent", version: "1" });
  const result = z.object({
    structuredContent: z.object({ result: TimelineViewSchema }),
  });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
        requestInit: { headers: { Origin: baseURL! } },
      }),
    );
    const read = async () =>
      result.parse(
        await client.callTool({
          name: "timeline_read",
          arguments: { projectId: project.id },
        }),
      ).structuredContent.result;
    const before = await read();
    const edited = await client.callTool({
      name: "timeline_edit",
      arguments: {
        projectId: project.id,
        expectedRevision: before.revision,
        commands: [
          {
            type: "setMarker",
            id: "beat",
            frame: 60,
            duration: 15,
            name: "Downbeat",
            color: "green",
            note: "Keep this cue",
          },
        ],
      },
    });
    expect(edited.isError).not.toBe(true);
    await page.goto(`/#project/${project.id}`);
    const marker = page.getByRole("button", {
      name: "Marker Downbeat",
      exact: true,
    });
    await marker.click();
    await expect(
      page.getByRole("button", { name: /^Current time/ }),
    ).toContainText("00:00:02:00");
    await marker.dblclick();
    const editor = page.getByRole("dialog", { name: "Edit marker" });
    await expect(
      editor.getByRole("button", { name: "Green", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.getByLabel("Marker name", { exact: true }).fill("Drop");
    await editor.getByRole("button", { name: "Violet", exact: true }).click();
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect
      .poll(async () => (await read()).timeline.markers[0])
      .toEqual({
        id: "beat",
        frame: 60,
        duration: 15,
        name: "Drop",
        color: "purple",
        note: "Keep this cue",
      });
    const drop = page.getByRole("button", { name: "Marker Drop", exact: true });
    expect(
      await drop.evaluate((element) =>
        getComputedStyle(element).getPropertyValue("--marker").trim(),
      ),
    ).toBe(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--marker-violet")
          .trim(),
      ),
    );
    await page.reload();
    await drop.focus();
    await page.keyboard.press("Enter");
    await expect(editor).toBeVisible();
    await page.getByLabel("Marker name", { exact: true }).fill("Cancel this");
    await page.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);
    await expect(drop).toBeVisible();
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(marker).toBeVisible();
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await drop.dblclick();
    await editor
      .getByRole("button", { name: "Delete marker", exact: true })
      .click();
    await expect(drop).toHaveCount(0);
    await expect.poll(async () => (await read()).timeline.markers).toEqual([]);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(drop).toBeVisible();

    // An agent's edit made while the editor is open survives a rename from the UI.
    await drop.dblclick();
    await expect(editor).toBeVisible();
    const open = await read();
    const moved = await client.callTool({
      name: "timeline_edit",
      arguments: {
        projectId: project.id,
        expectedRevision: open.revision,
        commands: [
          {
            type: "setMarker",
            id: "beat",
            frame: 90,
            duration: 30,
            name: "Drop",
            color: "yellow",
            note: "Agent moved this",
          },
        ],
      },
    });
    expect(moved.isError).not.toBe(true);
    // Space on a colour reached by keyboard picks it, and never starts playback.
    const time = await page
      .getByRole("button", { name: /^Current time/ })
      .textContent();
    await page.getByLabel("Marker name", { exact: true }).fill("Renamed");
    // Keyboard modality, then the Rose swatch: it matches :focus-visible like a tabbed control.
    await page.keyboard.press("Tab");
    await editor.getByRole("button", { name: "Rose", exact: true }).focus();
    await page.keyboard.press("Space");
    await expect(
      editor.getByRole("button", { name: "Rose", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("button", { name: /^Current time/ }),
    ).toHaveText(time!);
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .poll(async () => (await read()).timeline.markers[0])
      .toEqual({
        id: "beat",
        frame: 90,
        duration: 30,
        name: "Renamed",
        color: "pink",
        note: "Agent moved this",
      });
  } finally {
    await client.close();
  }
});

test("background requests do not delay note thumbnails or the captures queued behind them", async ({
  page,
  request,
}, testInfo) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Prompt captures", width: 640, height: 360 },
      })
    ).json(),
  );
  const base = `/api/cutroom/projects/${project.id}`;
  const source = SourceSchema.parse(
    await (await request.get(`${base}/source`)).json(),
  );
  const saved = await request.put(`${base}/source`, {
    data: {
      expectedVersion: source.version,
      content: source.content.replace(
        "</body>",
        "<script>setInterval(() => fetch(location.pathname + '?pulse=' + Date.now()), 200);</script></body>",
      ),
    },
  });
  expect(saved.ok()).toBe(true);
  await page.goto(`/#project/${project.id}`);
  await expect(
    page.frameLocator("iframe[data-live]").locator("#headline"),
  ).toHaveText("Prompt captures");
  await page.getByRole("button", { name: "Review", exact: true }).click();
  const captures: Promise<number>[] = [];
  for (let index = 0; index < 3; index++) {
    await page.getByRole("button", { name: /^Comment/ }).click();
    await page
      .getByLabel("Pin a comment on the composition")
      .click({ position: { x: 60 + index * 40, y: 60 } });
    const field = page.getByLabel("What should change?");
    const body = `Frame ${index + 1}`;
    await field.fill(body);
    const started = performance.now();
    await field.press("Enter");
    const row = page.locator(".review-row").filter({ hasText: body });
    captures.push(
      row
        .locator(".note-thumb img[data-loaded]")
        .waitFor({ state: "visible", timeout: 3000 })
        .then(() => Math.round(performance.now() - started)),
    );
    if (index < 2) {
      await page.getByRole("button", { name: /^Select/ }).click();
      await page.getByRole("region", { name: "Viewer", exact: true }).click();
      await page.keyboard.press("Shift+ArrowRight");
    }
  }
  const timings = await Promise.all(captures);
  await testInfo.attach("thumbnail-latency.json", {
    body: JSON.stringify(timings),
    contentType: "application/json",
  });
});
