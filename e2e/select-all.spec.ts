import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import { ProjectSchema } from "../src/shared/project";
import {
  ClipboardSchema,
  TimelineViewSchema,
} from "../src/shared/timeline/schema";

test("Ctrl+A selects unlocked clips and preserves native text selection", async ({
  page,
  request,
  context,
}, testInfo) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Select all clips" },
      })
    ).json(),
  );
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><body><main data-composition-id="main" data-fps="30" data-width="1920" data-height="1080" data-duration="12">
    <div id="picture" class="clip" data-start="0" data-duration="3" data-track-index="0" data-link="pair">Picture</div>
    <div id="locked" class="clip" data-start="0" data-duration="3" data-track-index="1" data-link="pair">Locked partner</div>
    <div id="off" class="clip" data-start="0" data-duration="3" data-track-index="2" data-enabled="false">Auto-select off</div>
  </main></body></html>`,
  );
  const base = `/api/cutroom/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${base}/timeline`)).json(),
    );
  const initial = await read();
  expect(
    (
      await request.post(`${base}/commands`, {
        data: {
          expectedRevision: initial.revision,
          commands: [
            { type: "setTrack", index: 1, locked: true },
            { type: "setTrack", index: 2, autoSelect: false },
            { type: "setClip", clipId: "off", enabled: false },
          ],
        },
      })
    ).ok(),
  ).toBe(true);
  const before = await read();
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator("[data-clip]")).toHaveCount(3);
  await page.getByRole("region", { name: "Viewer", exact: true }).click();
  await page.keyboard.press("Control+a");
  await page.screenshot({ path: testInfo.outputPath("ctrl-a.png") });
  await expect(page.locator("[data-clip].selected")).toHaveCount(2);
  await expect(page.locator('[data-clip="locked"]')).not.toHaveClass(
    /selected/,
  );
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
  await page.keyboard.press("Shift+A");
  await expect(page.locator("[data-clip].selected")).toHaveCount(0);
  const composer = page.getByRole("textbox", { name: "Message your agent" });
  await composer.fill("keep this text");
  await composer.press("Control+a");
  expect(
    await composer.evaluate((e: HTMLTextAreaElement) =>
      e.value.slice(e.selectionStart, e.selectionEnd),
    ),
  ).toBe("keep this text");
  await expect(page.locator("[data-clip].selected")).toHaveCount(0);
  // Real pointer selection remains available in chat, and Ctrl+C copies that text.
  const paragraph = page.locator(".chat-empty p").first();
  const box = await paragraph.boundingBox();
  if (!box) throw new Error("Chat text is not visible");
  await page.mouse.click(box.x + 22, box.y + 8, { clickCount: 3 });
  const selected = await page.evaluate(
    () => window.getSelection()?.toString() ?? "",
  );
  expect(selected).toContain("Describe an edit");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.keyboard.press("Control+c");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    selected,
  );
  for (const [kind, target] of [
    ["clip", page.locator('[data-clip="picture"]')],
    ["picture", page.getByRole("region", { name: "Viewer", exact: true })],
  ] as const) {
    await page.mouse.click(box.x + 22, box.y + 8, { clickCount: 3 });
    expect(
      await page.evaluate(() => window.getSelection()?.toString()),
    ).toContain("Describe an edit");
    await target.click();
    await page.keyboard.press("Control+a");
    await page.screenshot({
      path: testInfo.outputPath(`return-to-${kind}.png`),
    });
    await expect(page.locator("[data-clip].selected")).toHaveCount(2);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
      "",
    );
    const copied = page.waitForResponse(/\/timeline\/copy$/);
    await page.keyboard.press("Control+c");
    const clipboard = ClipboardSchema.parse(await (await copied).json());
    // Copy retains its existing linked-partner behavior, including the locked partner.
    expect(clipboard.clips.map((clip) => clip.id).sort()).toEqual([
      "locked",
      "off",
      "picture",
    ]);
    await page.keyboard.press("Shift+A");
  }
  expect((await read()).timeline).toEqual(before.timeline);
});
