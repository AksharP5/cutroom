import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "parse5";
import { z } from "zod";
import { createMcpServer } from "../src/server/mcp/server";
import { createVariableRoutes } from "../src/server/projects/variables";
import { createHyperframesApi } from "../src/server/hyperframes/api";
import { VariablesStateSchema } from "../src/shared/variables";
import { projectFixture } from "./project-fixture";

const DECLARATIONS = [
  { id: "title", type: "string", label: "Title", default: "Hello" },
  { id: "accent", type: "color", label: "Accent", default: "#ff0000" },
  {
    id: "size",
    type: "number",
    label: "Size",
    default: 64,
    min: 8,
    max: 200,
  },
];
const SOURCE = `<!doctype html>
<html data-composition-variables='${JSON.stringify(DECLARATIONS)}'>
<head><meta charset="utf-8"><style>#headline{color:var(--accent)}</style></head>
<body>
  <div id="root" data-composition-id="main" data-width="320" data-height="240" data-duration="2">
    <h1 id="headline" class="clip" data-start="0" data-duration="2" data-track-index="0" data-var-text="title">Hello</h1>
    <p id="caption" class="clip" data-start="0" data-duration="2" data-track-index="1" style="color: #00ff00">Plain words</p>
  </div>
</body>
</html>
`;

async function fixture() {
  const f = await projectFixture();
  const variables = createVariableRoutes(f.store, f.review);
  f.app.route("/api/cutroom", variables);
  const editor = createHyperframesApi(f.store, f.review);
  f.app.route("/api", editor);
  const project = await f.store.create({
    name: "Template",
    duration: 2,
    width: 320,
    height: 240,
  });
  const file = join(project.path, "index.html");
  await writeFile(file, SOURCE);
  const json = async (response: Response) => {
    const body: unknown = await response.json();
    if (!response.ok)
      throw new Error(
        `${response.status} ${z.object({ error: z.string() }).parse(body).error}`,
      );
    return VariablesStateSchema.parse(body);
  };
  const base = `/projects/${project.id}/variables`;
  return {
    ...f,
    variables,
    project,
    source: () => readFile(file, "utf8"),
    read: async () => json(await f.request(base)),
    preview: (values: unknown) =>
      f.request(`${base}/preview`, "PUT", { values }),
    setDefault: (id: string, value: unknown) =>
      f.request(`${base}/default`, "POST", { id, value }),
    declare: (body: unknown) => f.request(`${base}/declare`, "POST", body),
    undo: () => f.request(`/projects/${project.id}/history/undo`, "POST"),
    json,
    async close() {
      await editor.dispose();
      await f.close();
    },
  };
}

/** The declarations HyperFrames will read from the written file, through a real HTML parser. */
function writtenDeclarations(html: string): unknown {
  const root = parse(html).childNodes.find(
    (node) => "tagName" in node && node.tagName === "html",
  );
  const attribute =
    root && "attrs" in root
      ? root.attrs.find((item) => item.name === "data-composition-variables")
      : undefined;
  return attribute && JSON.parse(attribute.value);
}

/** Script elements an HTML parser finds, so markup inside an attribute value does not count. */
function scripts(html: string): number {
  const count = (node: unknown): number => {
    const parsed = z
      .object({
        tagName: z.string().optional(),
        childNodes: z.array(z.unknown()).optional(),
      })
      .parse(node);
    return (
      Number(parsed.tagName === "script") +
      (parsed.childNodes ?? []).reduce<number>(
        (sum, child) => sum + count(child),
        0,
      )
    );
  };
  return count(parse(html));
}

test("previewed overrides are checked against each declaration and never touch the source", async () => {
  const f = await fixture();
  try {
    const heard: unknown[] = [];
    f.variables.subscribe(f.project.id, (change) => heard.push(change));
    const state = await f.json(
      await f.preview({ title: "Q4 report", accent: "#0066ff", size: 64 }),
    );
    // The size equals its default, so it is not an override.
    expect(state.preview).toEqual({ title: "Q4 report", accent: "#0066ff" });
    expect(heard).toEqual([
      {
        composition: "index.html",
        preview: { title: "Q4 report", accent: "#0066ff" },
      },
    ]);
    expect(await f.source()).toBe(SOURCE);
    for (const [values, problem] of [
      [{ accent: "red; background: url(//evil)" }, "hex"],
      [{ accent: "var(--x)" }, "hex"],
      [{ size: 500 }, "200"],
      [{ size: "64" }, "number"],
      [{ subtitle: "x" }, "no such variable"],
      [{ title: "x".repeat(2001) }, "2000"],
    ] as const) {
      const response = await f.preview(values);
      expect([400, 422]).toContain(response.status);
      expect(await response.text()).toContain(problem);
    }
    // A refused set leaves the last accepted one.
    expect((await f.read()).preview).toEqual({
      title: "Q4 report",
      accent: "#0066ff",
    });
    expect((await f.json(await f.preview({}))).preview).toEqual({});
  } finally {
    await f.close();
  }
});

test("Set default rewrites only the declaration, as one undo step, and keeps hostile text as data", async () => {
  const f = await fixture();
  try {
    await f.json(await f.preview({ title: "x", accent: "#0066ff" }));
    const hostile = `Q4 "report" </html><script>alert(1)</script> &amp; it's '<b>`;
    const state = await f.json(await f.setDefault("title", hostile));
    // The written default is the override, so only the other override is left.
    expect(state.preview).toEqual({ accent: "#0066ff" });
    expect(
      state.declarations.find((item) => item.id === "title")?.default,
    ).toBe(hostile);
    const written = await f.source();
    expect(writtenDeclarations(written)).toEqual(
      DECLARATIONS.map((item) =>
        item.id === "title" ? { ...item, default: hostile } : item,
      ),
    );
    // Every byte outside the attribute value is as written, and no script element appeared.
    const [before, after] = SOURCE.split(JSON.stringify(DECLARATIONS));
    expect(written.startsWith(before!)).toBe(true);
    expect(written.endsWith(after!)).toBe(true);
    expect(scripts(written)).toBe(0);
    expect((await f.undo()).ok).toBe(true);
    expect(await f.source()).toBe(SOURCE);
  } finally {
    await f.close();
  }
});

test("declaring a variable binds a text element's words or colour, one undo step each", async () => {
  const f = await fixture();
  try {
    const words = await f.json(
      await f.declare({
        variable: {
          id: "caption-text",
          type: "string",
          label: "Caption",
          default: "Plain words",
        },
        bind: { clipId: "caption", to: "text" },
      }),
    );
    expect(words.declarations.map((item) => item.id)).toEqual([
      "title",
      "accent",
      "size",
      "caption-text",
    ]);
    expect(await f.source()).toContain(
      `<p id="caption" class="clip" data-start="0" data-duration="2" data-track-index="1" style="color: #00ff00" data-var-text="caption-text">Plain words</p>`,
    );
    await f.json(
      await f.declare({
        variable: {
          id: "caption-color",
          type: "color",
          label: "Caption colour",
          default: "#00ff00",
        },
        bind: { clipId: "caption", to: "color" },
      }),
    );
    expect(await f.source()).toContain(
      `style="color: var(--caption-color)" data-var-text="caption-text"`,
    );
    for (const [body, status] of [
      // An id the composition already declares.
      [
        {
          variable: { id: "title", type: "string", label: "T", default: "" },
        },
        409,
      ],
      // Words take a string variable.
      [
        {
          variable: { id: "n", type: "number", label: "N", default: 1 },
          bind: { clipId: "caption", to: "text" },
        },
        422,
      ],
      [
        {
          variable: { id: "x", type: "string", label: "X", default: "" },
          bind: { clipId: "missing", to: "text" },
        },
        404,
      ],
      // Words that already take a variable.
      [
        {
          variable: { id: "again", type: "string", label: "A", default: "" },
          bind: { clipId: "caption", to: "text" },
        },
        409,
      ],
      // An id that would not be a plain CSS custom property.
      [
        {
          variable: { id: "a;b", type: "string", label: "X", default: "" },
        },
        400,
      ],
    ] as const) {
      const response = await f.declare(body);
      expect(response.status).toBe(status);
    }
    expect((await f.undo()).ok).toBe(true);
    expect((await f.undo()).ok).toBe(true);
    expect(await f.source()).toBe(SOURCE);
  } finally {
    await f.close();
  }
});

test("agents list, preview, default and declare variables through typed tools, and export them", async () => {
  const f = await fixture();
  const server = createMcpServer({
    fetch: (url, init) => f.app.request(url, init),
  });
  const client = new Client({ name: "variables-test", version: "1" });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await server.connect(remote);
  await client.connect(local);
  const call = async (name: string, args: Record<string, unknown>) =>
    z
      .object({
        isError: z.boolean().optional(),
        content: z.array(z.object({ text: z.string() })),
        structuredContent: z.object({ result: z.unknown() }).optional(),
      })
      .parse(
        await client.callTool({
          name,
          arguments: { projectId: f.project.id, ...args },
        }),
      );
  try {
    const listed = await call("variables_list", {});
    expect(
      VariablesStateSchema.parse(listed.structuredContent?.result).declarations,
    ).toHaveLength(3);
    const previewed = await call("variables_preview", {
      values: { title: "From an agent" },
    });
    expect(
      VariablesStateSchema.parse(previewed.structuredContent?.result).preview,
    ).toEqual({ title: "From an agent" });
    expect(
      (await call("variables_preview", { values: { accent: "blue" } })).isError,
    ).toBe(true);
    await call("variables_set_default", { id: "size", value: 96 });
    expect(
      (writtenDeclarations(await f.source()) as { default: unknown }[])[2]
        ?.default,
    ).toBe(96);
    // Export refuses a value its declaration does not accept, before any job starts.
    const refused = await call("export_start", {
      variables: { size: 999 },
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain("200");
    const undeclared = await call("export_start", {
      variables: { nope: "x" },
    });
    expect(undeclared.isError).toBe(true);
  } finally {
    await client.close();
    await server.close();
    await f.close();
  }
});
