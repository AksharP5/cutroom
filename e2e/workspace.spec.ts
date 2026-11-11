import { hint } from "../src/client/keymap";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "./fixtures";
import {
  ProjectSchema,
  ProjectDocumentSchema,
  SourceSchema,
} from "../src/shared/project";
import { embeddedEditor } from "./embedded";

test("visual review, native skill selection, and script edits survive real workspace use", async ({
  page,
  request,
}) => {
  await embeddedEditor(page);
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
  await page.getByRole("button", { name: "Focus editor", exact: true }).click();
  await page.getByRole("button", { name: "Focus editor", exact: true }).click();
  await expect(composer).toHaveValue("Use $storyboard ");
  await page.reload();
  await expect(composer).toHaveValue("Use $storyboard ");
  await composer.fill("");

  await page
    .getByRole("button", { name: hint("cutroomComment"), exact: true })
    .click();
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
  await page.getByLabel("Footage", { exact: true }).click();
  await expect(
    page
      .getByRole("listbox", { name: "Footage options", exact: true })
      .getByRole("option"),
  ).toHaveCount(2);
  await page
    .getByRole("option", { name: "footage.mp4", exact: true })
    .first()
    .click();
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
  await page.getByLabel("Footage", { exact: true }).click();
  await page
    .getByRole("option", { name: "footage.mp4", exact: true })
    .last()
    .click();
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
  await page.screenshot({
    path: `${process.env.CUTROOM_E2E_DIR ?? "artifacts"}/workspace.png`,
    fullPage: true,
  });
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

test("media panel follows project media and imports files into assets", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Media shelf" },
      })
    ).json(),
  );
  const tone = (path: string) =>
    promisify(execFile)("ffmpeg", [
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440",
      "-t",
      "1",
      "-y",
      path,
    ]);
  await page.goto(`/#project/${project.id}`);
  const media = page.getByRole("region", { name: "Media", exact: true });
  await expect(media.getByText("No media yet")).toBeVisible();

  await mkdir(join(project.path, "sound.v2"), { recursive: true });
  await tone(join(project.path, "sound.v2", "room-tone.wav"));
  await expect(
    media.getByRole("listitem").filter({ hasText: "room-tone" }),
  ).toHaveAttribute("data-kind", "audio");

  const outside = await mkdtemp(join(tmpdir(), "cutroom-media-"));
  await tone(join(outside, "narration.mp3"));
  await media
    .locator('input[type="file"]')
    .setInputFiles(join(outside, "narration.mp3"));
  await expect(
    media.getByRole("listitem").filter({ hasText: "narration" }),
  ).toBeVisible();
  await stat(join(project.path, "assets", "narration.mp3"));

  await writeFile(join(outside, "notes.txt"), "not media");
  await media
    .locator('input[type="file"]')
    .setInputFiles(join(outside, "notes.txt"));
  await expect(media.getByRole("alert")).toContainText(
    "notes.txt is not a supported",
  );

  // Moving a whole folder out reports only the folder, even when its name has a dot.
  const moved = `${project.path}-sound`;
  await rename(join(project.path, "sound.v2"), moved);
  await expect(
    media.getByRole("listitem").filter({ hasText: "room-tone" }),
  ).toHaveCount(0);
  await rm(moved, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});
