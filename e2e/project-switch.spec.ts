import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "./fixtures";
import { ProjectSchema } from "../src/shared/project";

// Put a switch inside an outstanding paint, rather than hoping it lands between two frames.
const watchPaint = () => {
  if (window === window.top) return;
  addEventListener(
    "message",
    (event: MessageEvent<{ source?: string; action?: string }>) => {
      if (
        event.data?.source === "cutroom-viewer" &&
        event.data.action === "paint"
      )
        console.debug("switch-test-paint");
    },
  );
};

test("rapid project switches during playback and edit reloads produce no reports or page errors", async ({
  page,
  request,
}, testInfo) => {
  const projects = [];
  for (const name of ["Switch red", "Switch blue"]) {
    const project = ProjectSchema.parse(
      await (
        await request.post("/api/cutroom/projects", { data: { name } })
      ).json(),
    );
    await promisify(execFile)("ffmpeg", [
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=320x180:r=30:d=4",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=4",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-c:a",
      "aac",
      "-shortest",
      "-y",
      join(project.path, "footage.mp4"),
    ]);
    await writeFile(
      join(project.path, "index.html"),
      `<!doctype html><html><head><style>
      body{margin:0}main{position:relative;width:320px;height:180px}video{width:100%;height:100%}
      </style></head><body><main data-composition-id="main" data-width="320" data-height="180" data-duration="4" data-fps="30">
      <video id="footage" class="clip" data-start="0" data-duration="4" data-track-index="0" src="footage.mp4"></video>
      </main></body></html>`,
    );
    projects.push(project);
  }
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // Capture the rendered reports, including ones that disappear before the next assertion.
  const reports: string[] = [];
  await page.addInitScript(() => {
    if (window !== window.top) return;
    new MutationObserver(() => {
      for (const element of document.querySelectorAll(
        ".toast span[title], .status-error",
      )) {
        const text = element.textContent;
        if (text) console.debug(`switch-test-report:${text}`);
      }
    }).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
  await page.addInitScript(watchPaint);
  const errors: {
    text: string;
    source: { url: string; lineNumber: number; columnNumber: number };
  }[] = [];
  page.on("console", (message) => {
    if (message.text().startsWith("switch-test-report:"))
      reports.push(message.text().slice("switch-test-report:".length));
    if (message.type() === "error")
      errors.push({ text: message.text(), source: message.location() });
  });
  await page.goto(`/#project/${projects[0]!.id}`);
  for (let index = 0; index < 12; index++) {
    await expect(page.locator("iframe[data-live]")).toHaveCount(1);
    await page
      .getByRole("button", { name: "Play forward", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: /^Current time/ }),
    ).not.toHaveText("00:00:00:00");
    if (index % 2) {
      const painting = page.waitForEvent("console", {
        predicate: (message) => message.text() === "switch-test-paint",
      });
      const path = join(projects[index % 2]!.path, "index.html");
      await writeFile(
        path,
        (await readFile(path, "utf8")).replace(
          "</body>",
          `<!-- edit ${index} --></body>`,
        ),
      );
      await painting;
    }
    await page.evaluate(
      (id) => {
        location.hash = `project/${id}`;
      },
      projects[(index + 1) % 2]!.id,
    );
    await expect(page.locator(".project-switcher")).toHaveText(
      projects[(index + 1) % 2]!.name,
    );
  }
  await expect(page.locator("iframe[data-live]")).toHaveCount(1);
  // Old message requests used to time out at ten seconds. Let any leaked request report.
  await page.waitForTimeout(10_200);
  await page.screenshot({ path: testInfo.outputPath("rapid-switches.png") });
  await testInfo.attach("switch-reports", {
    body: JSON.stringify({ reports, errors, pageErrors }, null, 2),
    contentType: "application/json",
  });
  expect(reports).toEqual([]);
  expect(errors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("an active project's failed frame capture toasts the renderer's actual cause", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Failed active capture" },
      })
    ).json(),
  );
  // Invalid dimensions make the real thumbnail renderer reject the active request.
  await page.route(`**/api/projects/${project.id}/thumbnail/**`, (route) => {
    if (route.request().resourceType() !== "fetch") return route.fallback();
    return route.continue({ url: `${route.request().url()}&w=-1` });
  });
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator("iframe[data-live]")).toHaveCount(1);
  await page.keyboard.press("n");
  await page
    .getByLabel("Pin a comment on the composition")
    .click({ position: { x: 100, y: 100 } });
  const field = page.getByLabel("What should change?", { exact: true });
  await field.fill("Keep the note and explain the capture failure");
  const failed = page.waitForResponse(
    (response) =>
      response.url().includes(`/projects/${project.id}/thumbnail/`) &&
      response.status() === 500,
  );
  await field.press("Enter");
  const response = await failed;
  const { error } = await response.json();
  expect(error).toContain(
    "Thumbnail dimensions must be positive finite numbers",
  );
  await expect(page.locator(".toast")).toContainText(
    `Note saved without a frame image. ${error}`,
  );
});
