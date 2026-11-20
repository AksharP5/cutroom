import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { clipVersions } from "../src/server/projects/changes";
import { seekFrame } from "./position-helpers";
import { expect, test } from "./fixtures";

test("author undo and redo preserve migrated review marks, acceptance, and unrelated files", async ({
  page,
  request,
  baseURL,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Author history", width: 640, height: 360, duration: 10 },
      })
    ).json(),
  );
  const api = `/api/cutroom/projects/${project.id}`;
  const read = async (detail = false) =>
    TimelineViewSchema.parse(
      await (
        await request.get(`${api}/timeline${detail ? "?clipEdits=1" : ""}`)
      ).json(),
    );
  const client = new Client({ name: "Codex", version: "1" });
  const otherClient = new Client({ name: "Codex", version: "1" });
  const connect = (client: Client) =>
    client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", baseURL), {
        requestInit: { headers: { origin: baseURL! } },
      }),
    );
  await connect(client);
  await connect(otherClient);
  try {
    await page.goto(`/#project/${project.id}`);
    await expect(page.locator(".edit-stage[data-preview-ready]")).toBeVisible();
    const picture = page.frameLocator("iframe[data-live]").locator("#headline");
    await expect(picture).toHaveText("Author history");
    await seekFrame(page, 60);
    await page.keyboard.press("m");
    const marker = page.getByRole("button", { name: "Marker Marker 1" });
    await expect(marker).toBeVisible();
    await expect
      .poll(async () => (await read()).timeline.markers.length)
      .toBe(1);
    const markerBefore = (await read()).timeline.markers;
    const beforeSignature = (await clipVersions(project, "index.html")).get(
      "headline",
    );

    const edited = await client.callTool({
      name: "timeline_edit",
      arguments: {
        projectId: project.id,
        expectedRevision: (await read()).revision,
        commands: [
          { type: "setClip", clipId: "headline", text: "Codex opening" },
        ],
      },
    });
    expect(edited.isError, JSON.stringify(edited.content)).not.toBe(true);
    const { historyId } = z
      .object({ historyId: z.string() })
      .parse(edited.structuredContent);
    await expect(picture).toHaveText("Codex opening");
    const mark = page.locator('[data-agent-change="headline"]');
    await expect(mark).toBeVisible();
    const edit = (await read(true)).clipEdits?.find(
      (row) => row.clipId === "headline",
    );
    expect(edit).toMatchObject({ historyId, accepted: false });
    const signature = (await clipVersions(project, "index.html")).get(
      "headline",
    );
    const legacy = JSON.stringify({
      schemaVersion: 1,
      items: [],
      clipEdits: [{ ...edit, signature, beforeSignature }],
    });
    const ledger = join(project.path, ".cutroom/review.json");
    await writeFile(ledger, legacy);
    await page.reload();
    await expect(picture).toHaveText("Codex opening");
    await expect(mark).toBeVisible();
    expect(await readFile(ledger, "utf8")).toContain('"schemaVersion":2');
    expect(
      await readFile(join(project.path, ".cutroom/review.v1.json"), "utf8"),
    ).toBe(legacy);
    expect((await read(true)).clipEdits).toContainEqual(edit);

    const media = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ioAAAAASUVORK5CYII=",
      "base64",
    );
    const uploaded = await request.post(
      `/api/projects/${project.id}/upload?dir=assets`,
      {
        multipart: {
          file: { name: "imported.png", mimeType: "image/png", buffer: media },
        },
      },
    );
    expect(uploaded.ok(), await uploaded.text()).toBe(true);
    await writeFile(join(project.path, "assets/outside.png"), media);
    await expect(page.getByText("imported.png", { exact: true })).toBeVisible();
    await expect(page.getByText("outside.png", { exact: true })).toBeVisible();
    const html = await readFile(join(project.path, "index.html"), "utf8");
    const beforeUndo = await picture.screenshot();

    await page.keyboard.press("Control+z");
    await expect(marker).toHaveCount(0);
    await expect.poll(async () => (await read()).timeline.markers).toEqual([]);
    await expect(picture).toHaveText("Codex opening");
    await expect(mark).toBeVisible();
    expect(await picture.screenshot()).toEqual(beforeUndo);
    expect(await readFile(join(project.path, "index.html"), "utf8")).toBe(html);
    expect(await readFile(join(project.path, "assets/imported.png"))).toEqual(
      media,
    );
    expect(await readFile(join(project.path, "assets/outside.png"))).toEqual(
      media,
    );

    await page.keyboard.press("Control+z");
    await expect(page.getByText("Nothing of yours to undo")).toBeVisible();
    await expect(page.getByText("imported.png", { exact: true })).toBeVisible();
    await expect(page.getByText("outside.png", { exact: true })).toBeVisible();

    await page.keyboard.press("Control+Shift+z");
    await expect(marker).toBeVisible();
    await expect
      .poll(async () => (await read()).timeline.markers)
      .toEqual(markerBefore);
    await expect(picture).toHaveText("Codex opening");
    await expect(mark).toBeVisible();

    const history = (client: Client, name: string) =>
      client.callTool({ name, arguments: { projectId: project.id } });
    const stranger = await history(otherClient, "history_undo");
    expect(stranger.structuredContent).toMatchObject({
      result: { entry: null },
    });
    expect(
      (await history(client, "history_undo")).structuredContent,
    ).toMatchObject({
      result: {
        originalId: historyId,
        entry: { who: { kind: "agent", name: "Codex" } },
      },
    });
    await expect(picture).toHaveText("Author history");
    await expect(marker).toBeVisible();
    await expect(mark).toHaveCount(0);
    expect((await read(true)).clipEdits).not.toContainEqual(edit);
    expect(
      (await history(client, "history_redo")).structuredContent,
    ).toMatchObject({
      result: {
        originalId: historyId,
        entry: { who: { kind: "agent", name: "Codex" } },
      },
    });
    await expect(picture).toHaveText("Codex opening");
    await expect(marker).toBeVisible();
    await expect(mark).toBeVisible();
    expect((await read(true)).clipEdits).toContainEqual(edit);

    await page.getByRole("button", { name: "Review", exact: true }).click();
    const change = page
      .getByRole("complementary", { name: "Inspector" })
      .getByRole("button", { name: /Set text to .*Codex opening/ });
    await expect(change).toBeVisible();
    const acceptChange = page
      .getByRole("complementary", { name: "Inspector" })
      .getByRole("button", { name: "Accept", exact: true });
    await expect(acceptChange).toBeVisible();
    const accept = page.getByRole("button", {
      name: "Accept all agent changes",
    });
    await accept.click();
    await expect(acceptChange).toHaveCount(0);
    await expect(change).toBeVisible();
    await expect(mark).toHaveCount(0);
    await expect(picture).toHaveText("Codex opening");

    await history(client, "history_undo");
    await expect(picture).toHaveText("Author history");
    await history(client, "history_redo");
    await expect(picture).toHaveText("Codex opening");
    await expect(marker).toBeVisible();
    await expect(mark).toHaveCount(0);
    expect((await read(true)).clipEdits).toContainEqual({
      ...edit,
      accepted: true,
    });
  } finally {
    await Promise.all([client.close(), otherClient.close()]);
  }
});
