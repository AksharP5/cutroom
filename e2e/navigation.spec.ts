import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  MediaListSchema,
  ProjectSchema,
  SourceSchema,
} from "../src/shared/project";

async function localAgent(page: Page) {
  await page.route("**/api/cutroom/agents/capabilities?**", (route) =>
    route.fulfill({
      json: {
        provider: "codex",
        available: false,
        skills: [],
        models: [],
        mcpServers: [],
      },
    }),
  );
}

test("a saved review note opens its own composition and frame", async ({
  page,
  request,
}) => {
  await localAgent(page);
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Review navigation" },
      })
    ).json(),
  );
  const source = SourceSchema.parse(
    await (
      await request.get(`/api/cutroom/projects/${project.id}/source`)
    ).json(),
  );
  await writeFile(
    join(project.path, "second.html"),
    source.content
      .replaceAll("Review navigation", "Second composition")
      .replaceAll('data-duration="12"', 'data-duration="80"'),
  );
  const saved = await request.post(
    `/api/cutroom/projects/${project.id}/annotations`,
    {
      data: {
        kind: "comment",
        body: "Change the second composition here",
        compositionPath: "second.html",
        time: 63.25,
      },
    },
  );
  expect(saved.ok()).toBe(true);
  await page.goto(`/#project/${project.id}`);
  const frame = page.frameLocator("hyperframes-player iframe").last();
  await expect(frame.locator("#headline")).toHaveText("Review navigation");
  await page.locator(".review-note .note-seek").click();
  await expect(frame.locator("#headline")).toHaveText("Second composition");
  await expect(
    page.getByRole("slider", { name: "Seek preview", exact: true }),
  ).toHaveValue("63.25");
  expect(new URLSearchParams(page.url().split("?")[1]).get("comp")).toBe(
    "second.html",
  );
  await expect(
    page.getByRole("button", { name: "Review navigation", exact: true }),
  ).toBeVisible();
});

test("a canceled project creation cannot reopen itself or erase a later dialog", async ({
  page,
  request,
}) => {
  await localAgent(page);
  const first = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Existing first" },
      })
    ).json(),
  );
  const second = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: `Existing second ${crypto.randomUUID()}` },
      })
    ).json(),
  );
  let entered = () => {};
  let release = () => {};
  const pending = new Promise<void>((done) => {
    entered = done;
  });
  const released = new Promise<void>((done) => {
    release = done;
  });
  await page.route("**/api/cutroom/projects", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const response = await route.fetch();
    entered();
    await released;
    await route.fulfill({ response });
  });
  try {
    await page.goto(`/#project/${first.id}`);
    await page
      .getByRole("button", { name: "Cutroom projects", exact: true })
      .click();
    await page
      .getByRole("button", { name: "New project", exact: true })
      .click();
    await page
      .getByLabel("Project name", { exact: true })
      .fill("Canceled creation");
    await page
      .getByRole("button", { name: "Create project", exact: true })
      .click();
    await pending;
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page
      .getByRole("button", { name: "Cutroom projects", exact: true })
      .click();
    await page
      .getByRole("button")
      .filter({ has: page.getByText(second.name, { exact: true }) })
      .click();
    await expect(
      page.getByRole("button", { name: second.name, exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Cutroom projects", exact: true })
      .click();
    await page
      .getByRole("button", { name: "New project", exact: true })
      .click();
    await page
      .getByLabel("Project name", { exact: true })
      .fill("Keep this new draft");
    const loaded = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/cutroom/projects" &&
        response.request().method() === "GET",
    );
    release();
    await (await loaded).finished();
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    );
    await expect(
      page.getByRole("dialog", { name: "New project", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Project name", { exact: true })).toHaveValue(
      "Keep this new draft",
    );
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(
      page.getByRole("button", { name: second.name, exact: true }),
    ).toBeVisible();
    expect(page.url()).toContain(second.id);
  } finally {
    release();
  }
});

test("folder navigation cannot attach a file from the previous listing", async ({
  page,
  request,
}) => {
  await localAgent(page);
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Browse navigation" },
      })
    ).json(),
  );
  let entered = () => {};
  let release = () => {};
  const pending = new Promise<void>((done) => {
    entered = done;
  });
  const released = new Promise<void>((done) => {
    release = done;
  });
  await page.route("**/api/cutroom/browse?**", async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path");
    if (path === "/fixture/missing")
      return route.fulfill({
        status: 404,
        json: { error: "Missing test folder" },
      });
    if (path === "/fixture/next") {
      entered();
      await released;
      return route.fulfill({
        json: {
          path: "/fixture/next",
          parent: "/fixture",
          entries: [
            {
              name: "fresh.txt",
              path: "/fixture/next/fresh.txt",
              directory: false,
              size: 10,
            },
          ],
        },
      });
    }
    return route.fulfill({
      json: {
        path: "/fixture",
        parent: "/",
        entries: [
          {
            name: "old.txt",
            path: "/fixture/old.txt",
            directory: false,
            size: 10,
          },
          { name: "next", path: "/fixture/next", directory: true, size: 0 },
        ],
      },
    });
  });
  try {
    await page.goto(`/#project/${project.id}`);
    await page
      .getByRole("button", { name: "Attach a file", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "old.txt 0 KB", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "next", exact: true }).click();
    await pending;
    await expect(
      page.getByRole("button", { name: "old.txt 0 KB", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Attach file", exact: true }),
    ).toBeDisabled();
    release();
    await expect(
      page.getByRole("button", { name: "fresh.txt 0 KB", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Attach file", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "fresh.txt 0 KB", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Attach file", exact: true }),
    ).toBeEnabled();
    await page
      .getByLabel("Folder path", { exact: true })
      .fill("/fixture/missing");
    await page.getByLabel("Folder path", { exact: true }).press("Enter");
    await expect(
      page.getByText("Missing test folder", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".file-row")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Attach file", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Attach a file", exact: true }),
    ).toBeFocused();
  } finally {
    release();
  }
});

test("an anonymous second media clip keeps its script selected through a full cut and restore", async ({
  page,
  request,
}) => {
  await localAgent(page);
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Anonymous script restoration" },
      })
    ).json(),
  );
  const source = SourceSchema.parse(
    await (
      await request.get(`/api/cutroom/projects/${project.id}/source`)
    ).json(),
  );
  await mkdir(join(project.path, "assets"), { recursive: true });
  const secondMedia = join(project.path, "assets/second.wav");
  await promisify(execFile)("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=16000:cl=mono",
    "-t",
    "2",
    "-y",
    secondMedia,
  ]);
  await writeFile(
    join(project.path, "assets/first.wav"),
    await readFile(secondMedia),
  );
  const content = source.content.replace(
    "</main>",
    '<audio class="clip" src="assets/first.wav" data-start="0" data-duration="2" data-track-index="3" muted></audio><audio class="clip" src="assets/second.wav" data-start="2" data-duration="2" data-track-index="3" muted></audio></main>',
  );
  expect(
    (
      await request.put(`/api/cutroom/projects/${project.id}/source`, {
        data: { path: "index.html", expectedVersion: source.version, content },
      })
    ).ok(),
  ).toBe(true);
  const media = MediaListSchema.parse(
    await (
      await request.get(`/api/cutroom/projects/${project.id}/media`)
    ).json(),
  );
  const second = media.media.find(
    (clip) => clip.mediaPath === "assets/second.wav",
  );
  if (!second) throw new Error("The second test clip is missing.");
  await page.goto(`/#project/${project.id}`);
  await page.getByRole("button", { name: "Script", exact: true }).click();
  const footage = page.getByLabel("Footage", { exact: true });
  await footage.selectOption(`${second.sourceFile}:${second.elementId}`);
  await page.locator('.script-panel input[type="file"]').setInputFiles({
    name: "transcript.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify([
        { id: "keep", text: "keep", start: 0, end: 1 },
        { id: "room", text: "room", start: 1, end: 2 },
      ]),
    ),
  });
  await expect(
    page.getByRole("button", { name: "keep", exact: true }),
  ).toBeVisible();
  const canonicalMedia = MediaListSchema.parse(
    await (
      await request.get(`/api/cutroom/projects/${project.id}/media`)
    ).json(),
  );
  const canonical = canonicalMedia.media.find(
    (clip) => clip.mediaPath === second.mediaPath,
  );
  if (!canonical) throw new Error("The imported clip is missing.");
  expect(canonical.elementId).not.toBe(second.elementId);
  await expect(footage).toHaveValue(
    `${canonical.sourceFile}:${canonical.elementId}`,
  );
  await page.getByRole("button", { name: "keep", exact: true }).click();
  await page
    .getByRole("button", { name: "room", exact: true })
    .click({ modifiers: ["Shift"] });
  await page.getByRole("button", { name: "Cut", exact: true }).click();
  await expect(page.locator(".word-cut")).toHaveCount(2);
  await expect(footage).toHaveValue(
    `${canonical.sourceFile}:${canonical.elementId}`,
  );
  const afterCut = MediaListSchema.parse(
    await (
      await request.get(`/api/cutroom/projects/${project.id}/media`)
    ).json(),
  );
  expect(
    afterCut.media.find((clip) => clip.elementId === canonical.elementId)
      ?.duration,
  ).toBe(0);
  await page.getByRole("button", { name: "keep", exact: true }).click();
  await page
    .getByRole("button", { name: "room", exact: true })
    .click({ modifiers: ["Shift"] });
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.locator(".word-cut")).toHaveCount(0);
  await expect(footage).toHaveValue(
    `${canonical.sourceFile}:${canonical.elementId}`,
  );
  const restored = MediaListSchema.parse(
    await (
      await request.get(`/api/cutroom/projects/${project.id}/media`)
    ).json(),
  );
  expect(
    restored.media.find((clip) => clip.elementId === canonical.elementId)
      ?.duration,
  ).toBe(canonical.duration);
});

test("saving one review draft cannot clear a newer draft in the same project", async ({
  page,
  request,
}) => {
  await localAgent(page);
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Overlapping review drafts" },
      })
    ).json(),
  );
  await page.goto(`/#project/${project.id}`);
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    return canvas.toDataURL("image/png").split(",")[1] ?? "";
  });
  let entered = () => {};
  let release = () => {};
  const started = new Promise<void>((done) => {
    entered = done;
  });
  const released = new Promise<void>((done) => {
    release = done;
  });
  await page.route(
    `**/api/projects/${project.id}/thumbnail/**`,
    async (route) => {
      if (route.request().resourceType() !== "fetch") return route.fallback();
      entered();
      await released;
      await route.fulfill({
        contentType: "image/png",
        body: Buffer.from(png, "base64"),
      });
    },
  );
  try {
    await page
      .getByRole("button", { name: "Comment (C)", exact: true })
      .click();
    await page
      .getByLabel("Pin a comment on the composition")
      .click({ position: { x: 50, y: 50 } });
    const body = page.getByLabel("What should change?", { exact: true });
    await body.fill("Save the earlier note");
    await page.getByRole("button", { name: "Add note", exact: true }).click();
    await started;
    await expect(body).toBeDisabled();
    await page
      .getByRole("button", { name: "Comment (C)", exact: true })
      .click();
    await page
      .getByLabel("Pin a comment on the composition")
      .click({ position: { x: 100, y: 90 } });
    await expect(body).toBeEnabled();
    await body.fill("Keep the new draft");
    release();
    await expect
      .poll(
        async () =>
          (
            await (
              await request.get(`/api/cutroom/projects/${project.id}/document`)
            ).json()
          ).annotations.length,
      )
      .toBe(1);
    await expect(body).toHaveValue("Keep the new draft");
    await expect(
      page.getByRole("button", { name: "Add note", exact: true }),
    ).toBeEnabled();
  } finally {
    release();
  }
});
