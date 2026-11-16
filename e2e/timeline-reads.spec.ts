import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";

/**
 * One edit writes several project files, each announced as a file event. The editor reads the
 * timeline once per change, not once per file, and still shows an agent's edit.
 */
test("each change reads the timeline once, and outside edits still show", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", { data: { name: "Reads" } })
    ).json(),
  );
  const index = join(project.path, "index.html");
  const shots = Array.from(
    { length: 4 },
    (_, n) =>
      `<div id="shot-${n + 1}" class="clip" data-start="${n * 3}" data-duration="3" data-track-index="0">Shot ${n + 1}</div>`,
  );
  await writeFile(
    index,
    (await readFile(index, "utf8")).replace(
      /(<main[^>]*>)[\s\S]*<\/main>/,
      `$1\n${shots.join("\n")}\n</main>`,
    ),
  );
  const api = `/api/cutroom/projects/${project.id}`;
  const reads = { timeline: 0, history: 0 };
  page.on("request", (sent) => {
    if (sent.method() !== "GET") return;
    const path = new URL(sent.url()).pathname;
    if (path === `${api}/timeline`) reads.timeline++;
    if (path === `${api}/history`) reads.history++;
  });
  await page.goto(`/#project/${project.id}`);
  const clips = page
    .getByRole("region", { name: "Timeline" })
    .locator("[data-clip]");
  await expect(clips).toHaveCount(4);
  await page.getByRole("region", { name: "Viewer" }).click();
  await page.getByRole("button", { name: /^Current time/ }).click();
  await page.getByLabel("Go to time").pressSequentially("0100");
  await page.keyboard.press("Enter");
  await page.getByRole("region", { name: "Viewer" }).click();

  /** Reads after `change` once the timeline shows `count` clips and every file event has landed. */
  const readsFor = async (change: () => Promise<unknown>, count: number) => {
    // Earlier file events and their reads land first.
    await page.waitForTimeout(1000);
    reads.timeline = 0;
    reads.history = 0;
    await change();
    await expect(clips).toHaveCount(count);
    await page.waitForTimeout(1000);
    return { ...reads };
  };

  // The edit's own answer is the view; its file events bring the one read.
  expect(await readsFor(() => page.keyboard.press("e"), 5)).toEqual({
    timeline: 1,
    history: 2,
  });
  // Undo answers without a view, so it reads once itself and once for its file events.
  expect(await readsFor(() => page.keyboard.press("Control+z"), 4)).toEqual({
    timeline: 2,
    history: 2,
  });
  expect(
    await readsFor(async () => {
      const { revision } = TimelineViewSchema.parse(
        await (await request.get(`${api}/timeline`)).json(),
      );
      const response = await request.post(`${api}/commands`, {
        data: {
          expectedRevision: revision,
          label: "Agent",
          commands: [{ type: "remove", clipIds: ["shot-4"], ripple: false }],
        },
      });
      expect(response.ok()).toBe(true);
    }, 3),
  ).toEqual({ timeline: 1, history: 1 });
});
