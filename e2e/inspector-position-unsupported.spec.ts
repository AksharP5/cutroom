import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { expect, test } from "./fixtures";

for (const fixture of [
  {
    name: "late GSAP",
    style: "",
    script: `<script>setTimeout(()=>{const script=document.createElement('script');script.src='gsap.min.js';script.onload=()=>{window.__timelines.main=gsap.timeline({paused:true}).to('#title',{x:100,y:140,duration:1})};document.head.append(script)},100)</script>`,
    reason: /custom or delayed scripts/,
  },
  {
    name: "authored translate with GSAP",
    style: "#title{translate:20px 10px}",
    script: `<script src="gsap.min.js"></script><script>window.__timelines.main=gsap.timeline({paused:true}).to('#title',{x:100,y:140,duration:1});</script>`,
    reason: /CSS translate and GSAP/,
  },
  {
    name: "scaled ancestor",
    style: "main{transform:scale(.5);transform-origin:0 0}",
    script: "",
    reason: /transformed container/,
  },
]) {
  test(`${fixture.name}: position fields disable and MCP refuses without changing source or history`, async ({
    page,
    request,
    baseURL,
  }) => {
    const project = ProjectSchema.parse(
      await (
        await request.post("/api/cutroom/projects", {
          data: { name: fixture.name, width: 320, height: 240, duration: 2 },
        })
      ).json(),
    );
    await copyFile(
      join(process.cwd(), "node_modules/gsap/dist/gsap.min.js"),
      join(project.path, "gsap.min.js"),
    );
    const source = `<!doctype html><html><head><style>html,body{margin:0}#title{position:absolute;left:20px;top:30px;width:40px;height:30px;background:lime}${fixture.style}</style></head><body><main id="main" data-composition-id="main" data-width="320" data-height="240" data-duration="2"><div id="title" class="clip" data-start="0" data-duration="2">Title</div></main>${fixture.script}</body></html>`;
    await writeFile(join(project.path, "index.html"), source);
    await page.goto(`/#project/${project.id}`);
    await page.locator('[data-clip="title"]').click();
    const inspector = page.getByRole("complementary", { name: "Inspector" });
    const client = new Client({ name: "position-refusal", version: "1.0" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
          requestInit: { headers: { origin: baseURL! } },
        }),
      );
      const view = TimelineViewSchema.parse(
        await (
          await request.get(`/api/cutroom/projects/${project.id}/timeline`)
        ).json(),
      );
      const history = await (
        await request.get(`/api/cutroom/projects/${project.id}/history`)
      ).json();
      const result = await client.callTool({
        name: "timeline_edit",
        arguments: {
          projectId: project.id,
          expectedRevision: view.revision,
          commands: [{ type: "setClip", clipId: "title", x: 40, y: -10 }],
        },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(fixture.reason);
      expect(await readFile(join(project.path, "index.html"), "utf8")).toBe(
        source,
      );
      expect(
        await (
          await request.get(`/api/cutroom/projects/${project.id}/history`)
        ).json(),
      ).toEqual(history);
      await expect(
        inspector.getByRole("textbox", { name: "Position X", exact: true }),
      ).toBeDisabled();
      await expect(
        inspector.getByRole("textbox", { name: "Position Y", exact: true }),
      ).toBeDisabled();
      await expect(inspector.getByText(fixture.reason)).toBeVisible();
      await expect(inspector.getByText("No recent changes.")).toBeVisible();
    } finally {
      await client.close();
    }
  });
}
