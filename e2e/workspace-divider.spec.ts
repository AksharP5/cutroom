import { ProjectSchema } from "../src/shared/project";
import { expect, test } from "./fixtures";

test("the left divider keeps room for the viewer and remembers this window's width", async ({
  page,
  request,
  context,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Workspace divider" },
      })
    ).json(),
  );
  await page.goto(`/#project/${project.id}`);
  const divider = page.getByRole("separator", { name: "Resize left panel" });
  const media = page.getByRole("region", { name: "Media" });
  const work = page.getByRole("region", { name: "Project workspace" });
  const viewer = page.getByRole("region", { name: "Viewer" });
  await expect(viewer).toBeVisible();
  await expect(divider).toHaveAttribute("aria-valuenow", "320");

  await divider.press("ArrowRight");
  await expect(divider).toHaveAttribute("aria-valuenow", "336");
  const seam = await divider.boundingBox();
  if (!seam) throw new Error("The workspace divider has no bounds.");
  const x = seam.x + seam.width / 2;
  const y = seam.y + seam.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 450, y, { steps: 6 });
  await expect
    .poll(() => divider.boundingBox().then((box) => box?.x))
    .toBeGreaterThan(x + 300);
  expect((await work.boundingBox())?.width).toBe(336);
  await page.mouse.up();
  await expect(divider).toHaveAttribute("aria-valuenow", "683");
  expect((await media.boundingBox())?.width).toBe(683);
  expect((await work.boundingBox())?.width).toBe(683);
  expect((await viewer.boundingBox())?.width).toBeGreaterThanOrEqual(736);

  await page.reload();
  await expect(divider).toHaveAttribute("aria-valuenow", "683");
  const newWindow = await context.newPage();
  await newWindow.goto(`/#project/${project.id}`);
  await expect(
    newWindow.getByRole("separator", { name: "Resize left panel" }),
  ).toHaveAttribute("aria-valuenow", "320");
  await newWindow.close();

  await page.setViewportSize({ width: 1440, height: 1050 });
  await expect(divider).toHaveAttribute("aria-valuenow", "403");
  await page.setViewportSize({ width: 1720, height: 1050 });
  await expect(divider).toHaveAttribute("aria-valuenow", "683");
  await divider.dblclick();
  await expect(divider).toHaveAttribute("aria-valuenow", "320");
});
