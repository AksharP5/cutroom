import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import { ProjectSchema } from "../src/shared/project";

const composition = (video: string) =>
  `<!doctype html><html><body><main data-composition-id="main" data-fps="30" data-width="1920" data-height="1080" data-duration="8" data-no-timeline>
    <div id="title" class="clip" data-start="0" data-duration="2" data-track-index="1">Title</div>
    ${video}
  </main></body></html>`;

test("the status bar lists lint findings, jumps to a finding's clip, and recounts after a fix", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Lint findings" },
      })
    ).json(),
  );
  const index = join(project.path, "index.html");
  await writeFile(
    index,
    composition(
      `<video id="broll" class="clip" data-start="3" data-duration="2" data-track-index="0" src="assets/broll.mp4"></video>`,
    ),
  );
  await page.goto(`/#project/${project.id}`);
  const status = page.locator(".status-bar .status-lint");
  // The video declares no sound and its file is missing.
  await expect(status).toHaveText("2 errors");

  await status.click();
  const finding = page.getByRole("menuitem").filter({ hasText: "#broll" });
  await expect(finding).toContainText("declares neither muted");
  await finding.click();
  await expect(page.locator('[data-clip="broll"]')).toHaveClass(/selected/);
  await expect(
    page.getByRole("button", { name: /^Current time/ }),
  ).toContainText("00:00:03:00");

  await writeFile(
    index,
    composition(
      `<video id="broll" class="clip" data-start="3" data-duration="2" data-track-index="0" src="assets/broll.mp4" muted></video>`,
    ),
  );
  await expect(status).toHaveText("1 error");
});
