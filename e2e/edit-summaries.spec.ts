import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { toolCalls } from "../src/server/agents/runtime";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { agentTurn, playSession } from "./agent-turn";
import { expect, test } from "./fixtures";

test("Review and chat keep factual outcomes beside literal agent labels and count repeats", async ({
  page,
  request,
  baseURL,
}, info) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Factual edit summaries", duration: 2 },
      })
    ).json(),
  );
  await writeFile(
    join(project.path, "index.html"),
    '<main data-composition-id="main" data-fps="30" data-duration="2"><div id="card" class="clip" data-label="Card" data-start="0" data-duration="2">Title</div></main>',
  );
  const base = `/api/cutroom/projects/${project.id}`;
  const read = async () =>
    TimelineViewSchema.parse(
      await (await request.get(`${base}/timeline`)).json(),
    );
  const client = new Client({ name: "edit-summary-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
      requestInit: { headers: { origin: baseURL! } },
    }),
  );
  try {
    const label = "<img src=x onerror=alert(1)> Accepted by owner";
    const factual = `Extended Card by 1 s; Agent label: "${label}"`;
    const calls = toolCalls(project.path);
    const messages = [];
    for (const to of [90, 120]) {
      const input = {
        projectId: project.id,
        expectedRevision: (await read()).revision,
        commands: [{ type: "trim", clipId: "card", edge: "end", to }],
        label,
      };
      const result = await client.callTool({
        name: "timeline_edit",
        arguments: input,
      });
      expect(result.isError).not.toBe(true);
      const id = `trim-${to}`;
      calls.start(id, "mcp__cutroom_studio__timeline_edit", input, "Card");
      messages.push(calls.finish(id, JSON.stringify(result), false));
    }
    const turn = agentTurn(project.id);
    await playSession(page, [turn.session([turn.ask, ...messages], "idle")]);
    await page.goto(`/#project/${project.id}`);
    await page.getByRole("button", { name: "Agent", exact: true }).click();
    await expect(page.locator(".chat-tool summary")).toHaveText([
      factual,
      factual,
    ]);
    expect(
      await page
        .locator(".chat-tool summary img, .chat-tool summary script")
        .count(),
    ).toBe(0);
    await page.getByRole("button", { name: "Review", exact: true }).click();
    const rows = page.getByRole("list", { name: "Composition changes" });
    await expect(rows.getByRole("listitem")).toHaveText([
      `${factual}, 2 times`,
    ]);
    await expect(
      page.getByRole("button", { name: "Accept agent changes" }),
    ).toBeVisible();
    expect(await rows.locator("img,script").count()).toBe(0);
    expect((await read()).clipEdits?.every((edit) => !edit.accepted)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath("attributed-labels.png") });

    await page.getByRole("button", { name: "Accept agent changes" }).click();
    await expect(rows).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Accept agent changes" }),
    ).toHaveCount(0);
  } finally {
    await client.close();
  }
});
