import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { ProjectSchema } from "../src/shared/project";
import { expect, test } from "./fixtures";
import { waitForPreview } from "./preview-ready";

const HistorySchema = z.object({
  entries: z.array(z.object({ undone: z.boolean() })),
});
const DECLARATIONS = [
  { id: "title", type: "string", label: "Title", default: "Quarterly" },
  { id: "accent", type: "color", label: "Accent", default: "#3a6df0" },
  {
    id: "size",
    type: "number",
    label: "Size",
    default: 240,
    min: 40,
    max: 600,
  },
];

const shown = (page: Page, id: string) =>
  page.locator("iframe[data-live]").contentFrame().locator(`#${id}`);

/** The middle pixel of a rendered file's first frame, as RGB. */
async function pixel(path: string, x: number, y: number) {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      path,
      "-frames:v",
      "1",
      "-vf",
      `crop=w=2:h=2:x=${x}:y=${y},scale=1:1`,
      "-pix_fmt",
      "rgb24",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { encoding: "buffer" },
  );
  expect(result.status, result.stderr.toString()).toBe(0);
  return [...result.stdout];
}

test("variables preview live from the inspector and an agent, become defaults in one step, and export as previewed", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Template", width: 640, height: 360, duration: 1 },
      })
    ).json(),
  );
  const index = join(project.path, "index.html");
  await writeFile(
    index,
    (await readFile(index, "utf8"))
      .replace(
        '<html lang="en">',
        `<html lang="en" data-composition-variables='${JSON.stringify(DECLARATIONS)}'>`,
      )
      .replace(
        "</style>",
        ".badge { position: absolute; left: 0; top: 0; height: 100px; background: var(--accent); width: calc(var(--size) * 1px); }\n</style>",
      )
      .replace(
        'data-label="Project title">Template',
        'data-label="Project title" data-var-text="title">Quarterly',
      )
      .replace(
        "</main>",
        '<div id="badge" class="clip badge" data-start="0" data-duration="1" data-track-index="3"></div>\n</main>',
      ),
  );
  const authored = await readFile(index, "utf8");
  const steps = async () =>
    HistorySchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/history`)
      ).json(),
    ).entries.filter((entry) => !entry.undone).length;

  await page.goto(`/#project/${project.id}`);
  await waitForPreview(page);
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const variables = inspector.locator(".inspector-variables");
  await expect(variables).toContainText("Variables");
  const headline = shown(page, "headline");
  const badge = shown(page, "badge");
  await expect(headline).toHaveText("Quarterly");
  await expect(badge).toHaveCSS("background-color", "rgb(58, 109, 240)");
  const type = async (field: string, value: string) => {
    const input = variables.getByRole("textbox", { name: field, exact: true });
    await input.fill(value);
    await input.press("Enter");
  };
  const url = page.url();

  await type("Title", "Q4 report");
  await expect(headline).toHaveText("Q4 report");
  await type("Accent hex", "ff3366");
  await expect(badge).toHaveCSS("background-color", "rgb(255, 51, 102)");
  await type("Size", "480");
  await expect(badge).toHaveCSS("width", "480px");
  // A value its declaration refuses never reaches the viewer, and the field shows the last one.
  await type("Size", "900");
  await expect(
    page.getByRole("status").or(page.getByRole("alert")),
  ).toContainText("600");
  await expect(
    variables.getByRole("textbox", { name: "Size", exact: true }),
  ).toHaveValue("480");
  await expect(badge).toHaveCSS("width", "480px");
  // Hostile words stay words: HyperFrames sets text, so no element is created from them.
  const hostile = `<img src=x onerror="document.title='owned'">`;
  await type("Title", hostile);
  await expect(headline).toHaveText(hostile);
  await expect(headline.locator("img")).toHaveCount(0);
  // Previews never write the source or history, and the editor itself never reloaded.
  expect(await readFile(index, "utf8")).toBe(authored);
  expect(page.url()).toBe(url);

  // An agent's override reaches the open editor and its viewer.
  const before = await steps();
  expect(
    (
      await request.put(
        `/api/cutroom/projects/${project.id}/variables/preview`,
        { data: { values: { title: "From the agent", accent: "#ff3366" } } },
      )
    ).ok(),
  ).toBe(true);
  await expect(headline).toHaveText("From the agent");
  await expect(badge).toHaveCSS("width", "240px");
  await expect(
    variables.getByRole("textbox", { name: "Title", exact: true }),
  ).toHaveValue("From the agent");

  // Set default writes the declaration as one undo step; undo puts the source back.
  await variables
    .locator(".inspector-field", { hasText: "Title" })
    .getByRole("button", { name: "Set default" })
    .click();
  await expect.poll(steps).toBe(before + 1);
  await expect
    .poll(async () => readFile(index, "utf8"))
    .toContain('"default":"From the agent"');
  await expect(headline).toHaveText("From the agent");
  await page.keyboard.press("Control+z");
  await expect.poll(async () => readFile(index, "utf8")).toBe(authored);
  // The override went into the default, so undoing that shows the old default again.
  await expect(headline).toHaveText("Quarterly");

  // The Export dialog starts from the viewer's overrides and the file shows them.
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export", exact: true });
  await expect(dialog.locator(".export-variables")).toBeVisible();
  await expect(
    dialog.getByRole("textbox", { name: "Title", exact: true }),
  ).toHaveValue("Quarterly");
  await expect(dialog.getByLabel("Accent", { exact: true })).toHaveValue(
    "#ff3366",
  );
  await dialog.getByRole("textbox", { name: "Size", exact: true }).fill("320");
  const started = page.waitForRequest(
    (sent) => sent.method() === "POST" && sent.url().endsWith("/render"),
  );
  const answered = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/render"),
  );
  await dialog.getByRole("button", { name: "Export MP4", exact: true }).click();
  expect(
    z.object({ variables: z.unknown() }).parse((await started).postDataJSON())
      .variables,
  ).toEqual({ accent: "#ff3366", size: 320 });
  const { outputPath } = z
    .object({ outputPath: z.string() })
    .parse(await (await answered).json());
  await expect(dialog).toContainText("Export complete.", { timeout: 60_000 });
  // Inside the badge's 320 pixels, its override colour; past them, the page.
  const [red, green, blue] = await pixel(outputPath, 300, 50);
  expect(red).toBeGreaterThan(230);
  expect(green).toBeLessThan(80);
  expect(blue).toBeGreaterThan(80);
  const [, , outside] = await pixel(outputPath, 340, 50);
  expect(outside).toBeLessThan(40);
});
