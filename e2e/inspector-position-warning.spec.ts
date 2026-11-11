import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";

for (const conflict of [true, false]) {
  test(
    conflict
      ? "translate animation warns only at frames where it overrides Position"
      : "GSAP x/y animation holds Position without a warning",
    async ({ page, request, baseURL }, info) => {
      const project = ProjectSchema.parse(
        await (
          await request.post("/api/cutroom/projects", {
            data: {
              name: "Position warning",
              width: 320,
              height: 240,
              duration: 3,
            },
          })
        ).json(),
      );
      await copyFile(
        join(process.cwd(), "node_modules/gsap/dist/gsap.min.js"),
        join(project.path, "gsap.min.js"),
      );
      await writeFile(
        join(project.path, "index.html"),
        `<!doctype html><html><head><style>html,body{margin:0}#title{position:absolute;left:30px;top:80px;width:100px;height:40px;background:lime}</style><script src="gsap.min.js"></script></head><body><main id="main" data-composition-id="main" data-width="320" data-height="240" data-fps="30" data-duration="3"><div id="title" class="clip" data-start="0" data-duration="3">Slide-in title</div><div id="other" class="clip" data-start="0" data-duration="3" data-track-index="1">Other</div></main><script>window.__timelines.main=gsap.timeline({paused:true})${conflict ? ".to('#title',{translate:'80px 0px',duration:1,ease:'none'},.5).set('#title',{translate:'40px 0px'},1.5)" : ".fromTo('#title',{x:-30,y:10},{x:30,y:0,duration:1,ease:'none'},.5)"};</script></body></html>`,
      );
      await page.addInitScript(() => {
        const overrides: number[] = [];
        Object.assign(window, { positionOverrides: overrides });
        addEventListener("message", (event) => {
          if (event.data?.type === "position-warning" && event.data.overridden)
            overrides.push(event.data.time);
        });
      });
      await page.goto(`/#project/${project.id}`);
      await page.locator('[data-clip="title"]').click();
      const inspector = page.getByRole("complementary", { name: "Inspector" });
      const field = inspector.getByRole("textbox", {
        name: "Position X",
        exact: true,
      });
      const path = `/api/cutroom/projects/${project.id}`;
      const client = new Client({ name: "position-warning", version: "1.0" });
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
            requestInit: { headers: { origin: baseURL! } },
          }),
        );
        const before = TimelineViewSchema.parse(
          await (await request.get(`${path}/timeline`)).json(),
        );
        const result = await client.callTool({
          name: "timeline_edit",
          arguments: {
            projectId: project.id,
            expectedRevision: before.revision,
            commands: [{ type: "setClip", clipId: "title", x: 40 }],
          },
        });
        expect(result.isError).not.toBe(true);
        await expect(field).toHaveValue("40 px");
        await expect(
          page.locator(".edit-stage[data-preview-ready]"),
        ).toBeVisible();
        const warning = inspector.getByRole("status");
        const seek = async (frame: number) => {
          await page
            .getByRole("button", {
              name: "Current time. Click to type a time.",
            })
            .click();
          const time = page.getByRole("textbox", {
            name: "Go to time",
            exact: true,
          });
          await time.pressSequentially(
            String(Math.floor(frame / 30) * 100 + (frame % 30)).padStart(
              8,
              "0",
            ),
          );
          await time.press("Enter");
          await expect
            .poll(() =>
              page
                .frameLocator("iframe[data-live]")
                .locator("#title")
                .evaluate((element) => getComputedStyle(element).translate),
            )
            .toBe(conflict && frame === 30 ? "60px" : "40px");
        };
        for (const frame of [0, 30, 60, 30, 0]) {
          await seek(frame);
          if (conflict && frame === 30) {
            await expect(warning).toHaveText(
              "This clip's animation overrides Position at 00:00:01:00.",
            );
            await expect(field).toBeEnabled();
            await page.screenshot({
              path: info.outputPath("position-warning.png"),
            });
            await page.locator('[data-clip="other"]').click();
            await expect(warning).toHaveCount(0);
            await page.locator('[data-clip="title"]').click();
            await expect(warning).toBeVisible();
          } else {
            await expect(warning).toHaveCount(0);
          }
        }
        await page
          .getByRole("button", { name: "Play forward", exact: true })
          .click();
        if (conflict) await expect(warning).toBeVisible();
        else {
          await expect
            .poll(() =>
              page
                .frameLocator("iframe[data-live]")
                .locator("#title")
                .evaluate((element) => element.getBoundingClientRect().left),
            )
            .toBe(100);
          await expect(warning).toHaveCount(0);
        }
        await page.getByRole("button", { name: "Stop", exact: true }).click();
        await seek(60);
        await expect(warning).toHaveCount(0);
        if (!conflict)
          expect(
            await page.evaluate(
              () =>
                (window as unknown as { positionOverrides: number[] })
                  .positionOverrides,
            ),
          ).toEqual([]);
      } finally {
        await client.close();
      }
    },
  );
}

test("scale, rotation and zoom warn without blocking edits, and reset clears the warning", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Position units", width: 320, height: 240, duration: 2 },
      })
    ).json(),
  );
  const fixtures = [
    { id: "matrix", ancestor: "transform:scale(.5)", clip: "" },
    { id: "zoom", ancestor: "zoom:1.5", clip: "" },
    { id: "scale", ancestor: "", clip: "scale:.5" },
    { id: "rotate", ancestor: "rotate:15deg", clip: "" },
  ];
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><body><main id="main" data-composition-id="main" data-width="320" data-height="240" data-fps="30" data-duration="2">${fixtures.map(({ id, ancestor, clip }, track) => `<section style="${ancestor}"><div id="${id}" class="clip" data-start="0" data-duration="2" data-track-index="${track}" style="position:absolute;width:40px;height:30px;background:lime;${clip}">${id}</div></section>`).join("")}</main></body></html>`,
  );
  await page.goto(`/#project/${project.id}`);
  const path = `/api/cutroom/projects/${project.id}`;
  const view = TimelineViewSchema.parse(
    await (await request.get(`${path}/timeline`)).json(),
  );
  const response = await request.post(`${path}/commands`, {
    data: {
      expectedRevision: view.revision,
      commands: fixtures.map(({ id }) => ({
        type: "setClip",
        clipId: id,
        x: 40,
      })),
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  for (const { id } of fixtures) {
    await page.locator(`[data-clip="${id}"]`).click();
    await expect(inspector.getByRole("status")).toContainText(
      "overrides Position",
    );
    await expect(
      inspector.getByRole("textbox", { name: "Position X", exact: true }),
    ).toBeEnabled();
    await inspector.getByRole("button", { name: "Reset position" }).click();
    await expect(
      inspector.getByRole("textbox", { name: "Position X", exact: true }),
    ).toHaveValue("0 px");
    await expect(inspector.getByRole("status")).toHaveCount(0);
  }
});
