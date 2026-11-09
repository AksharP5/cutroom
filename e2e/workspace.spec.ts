import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import {
  ProjectSchema,
  ProjectDocumentSchema,
  SourceSchema,
} from "../src/shared/project";

test("visual review, native skill selection, and script edits survive real workspace use", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  const scriptRequests: string[] = [];
  page.on("request", (request) => {
    if (
      /\/api\/cutroom\/projects\/[^/]+\/(media|transcripts)$/.test(
        new URL(request.url()).pathname,
      )
    )
      scriptRequests.push(request.url());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/cutroom/agents/capabilities?**", (route) =>
    route.fulfill({
      json: {
        provider: "codex",
        available: true,
        skills: [
          {
            name: "storyboard",
            description: "Plan scenes for a video.",
            enabled: true,
          },
        ],
        models: [],
        mcpServers: [],
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page
    .getByLabel("Project name", { exact: true })
    .fill("A new perspective");
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Export", exact: true }),
  ).toBeVisible();
  const id = /#project\/([^?]+)/.exec(page.url())?.[1];
  expect(id).toBeTruthy();
  const project = ProjectSchema.parse(
    await (await request.get(`/api/cutroom/projects/${id}`)).json(),
  );
  const frame = page.frameLocator("hyperframes-player iframe").last();
  await expect(frame.locator("#headline")).toHaveText("A new perspective");
  expect(scriptRequests).toHaveLength(0);

  await page
    .getByRole("button", { name: "Toggle project files", exact: true })
    .click();
  await expect(
    page.getByText("Compositions", { exact: true }).first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Toggle project files", exact: true })
    .click();
  await expect(page.getByText("Catalog", { exact: true })).toHaveCount(0);

  const composer = page.getByLabel("Message your agent");
  await composer.fill("Use $story");
  await expect(page.getByRole("listbox", { name: "Skills" })).toBeVisible();
  await composer.press("Enter");
  await expect(composer).toHaveValue("Use $storyboard ");
  await page
    .getByRole("button", { name: "Toggle agent chat", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Toggle agent chat", exact: true })
    .click();
  await expect(composer).toHaveValue("Use $storyboard ");
  await page.reload();
  await expect(composer).toHaveValue("Use $storyboard ");
  await composer.fill("");

  await page.getByRole("button", { name: "Comment (C)", exact: true }).click();
  const canvas = page.getByLabel("Pin a comment on the composition");
  await expect(canvas).toBeVisible();
  await canvas.click({ position: { x: 150, y: 120 } });
  const note = page.getByLabel("What should change?", { exact: true });
  await note.fill("Give the title a little more room.");
  await page.getByRole("button", { name: "Script", exact: true }).click();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(note).toHaveValue("Give the title a little more room.");
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await expect(
    page.getByText("Give the title a little more room.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "View annotated frame" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "View annotated frame" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();

  await page.getByRole("button", { name: "Undo edit", exact: true }).click();
  await expect(
    page.getByText("Give the title a little more room.", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Redo edit", exact: true }).click();
  await expect(
    page.getByText("Give the title a little more room.", { exact: true }),
  ).toBeVisible();

  const assets = join(project.path, "assets");
  await mkdir(assets, { recursive: true });
  const media = join(assets, "footage.mp4");
  await promisify(execFile)("ffmpeg", [
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=24",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=300:sample_rate=16000",
    "-t",
    "4",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-c:a",
    "aac",
    "-y",
    media,
  ]);
  const originalHash = createHash("sha256")
    .update(await readFile(media))
    .digest("hex");
  const source = SourceSchema.parse(
    await (await request.get(`/api/cutroom/projects/${id}/source`)).json(),
  );
  const clips =
    '<video id="footage" class="clip" src="assets/footage.mp4" data-start="0" data-duration="2" data-track-index="3" style="position:absolute;right:8%;bottom:12%;width:480px;height:270px" muted></video><video id="second" class="clip" src="assets/footage.mp4" data-start="2" data-duration="2" data-track-index="3" style="position:absolute;right:8%;bottom:12%;width:480px;height:270px" muted></video>';
  const write = await request.put(`/api/cutroom/projects/${id}/source`, {
    data: {
      path: "index.html",
      content: source.content.replace("</main>", clips + "</main>"),
      expectedVersion: source.version,
    },
  });
  expect(write.ok()).toBeTruthy();
  await expect(frame.locator("#footage")).toBeAttached();
  await expect(frame.locator("#second")).toBeAttached();
  await page.getByRole("button", { name: "Script", exact: true }).click();
  await page
    .getByRole("button", { name: "Refresh media clips", exact: true })
    .click();
  await expect(
    page.getByLabel("Footage", { exact: true }).locator("option"),
  ).toHaveCount(2);
  await page
    .getByLabel("Footage", { exact: true })
    .selectOption("index.html:footage");
  await page.locator('.script-panel input[type="file"]').setInputFiles({
    name: "transcript.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify([
        { id: "make", text: "Make", start: 0.1, end: 0.4 },
        { id: "room", text: "room", start: 0.5, end: 0.9 },
      ]),
    ),
  });
  await expect(
    page.getByRole("button", { name: "Make", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Make", exact: true }).click();
  await page
    .getByRole("button", { name: "room", exact: true })
    .click({ modifiers: ["Shift"] });
  await page.getByRole("button", { name: "Cut", exact: true }).click();
  await expect(page.locator(".word-cut")).toHaveCount(2);
  await page.getByRole("button", { name: "Make", exact: true }).click();
  await page
    .getByRole("button", { name: "room", exact: true })
    .click({ modifiers: ["Shift"] });
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.locator(".word-cut")).toHaveCount(0);
  await page
    .getByLabel("Footage", { exact: true })
    .selectOption("index.html:second");
  await expect(
    page.getByRole("button", { name: "Transcribe locally", exact: true }),
  ).toBeVisible();
  expect(
    createHash("sha256")
      .update(await readFile(media))
      .digest("hex"),
  ).toBe(originalHash);

  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page
    .getByRole("button", { name: "Use 1 note in chat", exact: true })
    .click();
  await expect(composer).toHaveValue(/pending review notes/);
  await composer.fill("");
  await page.screenshot({ path: "artifacts/workspace.png", fullPage: true });
  const document = ProjectDocumentSchema.parse(
    await (await request.get(`/api/cutroom/projects/${id}/document`)).json(),
  );
  expect(document.annotations).toHaveLength(1);
  expect(document.transcripts).toHaveLength(1);
  const visible = await page.locator("body").innerText();
  expect(visible).not.toMatch(
    /Framey|Learn HyperFrames|Discord|Reddit|Feedback|HeyGen|Catalog/,
  );
  expect(errors).toEqual([]);
});
