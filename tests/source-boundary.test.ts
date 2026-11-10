import { expect, test } from "bun:test";
import { mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileContentVersion } from "@hyperframes/studio-server";
import { SourceSchema } from "../src/shared/project";
import { AGENT_HEADER } from "../src/shared/review";
import { createHyperframesApi } from "../src/server/hyperframes/api";
import { projectFixture } from "./project-fixture";

for (const agent of [true, false])
  test(`${agent ? "agent" : "human"} source writes refuse permissions, instructions, and non-composition files`, async () => {
    const fixture = await projectFixture();
    const project = await fixture.store.create({ name: "Protected source" });
    const editor = createHyperframesApi(fixture.store, fixture.review);
    fixture.app.route("/api/editor", editor);
    const turn = await fixture.review.beginTurn(project, {
      kind: "message",
      id: "run",
      token: "agent",
    });
    const original = '{"original":true}';
    const blocked = [
      ".claude/settings.local.json",
      ".codex/config.toml",
      ".git/config",
      "CLAUDE.md",
      "AGENTS.md",
      "AGENTS.override.md",
      "GEMINI.md",
      ".mcp.json",
      "scenes/.private/data.json",
      "package.json",
      "mcp.json",
      "opencode.jsonc",
      "tsconfig.base.json",
      "CLAUDE.local.md",
      "vite.config.js",
      "script.sh",
      "notes.txt",
    ];
    try {
      for (const path of blocked) {
        await mkdir(dirname(join(project.path, path)), { recursive: true });
        await writeFile(join(project.path, path), original);
        const response = await fixture.app.request(
          `/api/cutroom/projects/${project.id}/source`,
          {
            method: "PUT",
            headers: {
              "content-type": "application/json",
              ...(agent && { [AGENT_HEADER]: "agent" }),
            },
            body: JSON.stringify({
              path,
              content: "changed",
              expectedVersion: fileContentVersion(original),
            }),
          },
        );
        expect(response.status, path).toBe(403);
        expect(await readFile(join(project.path, path), "utf8")).toBe(original);
        const embedded = await fixture.app.request(
          `/api/editor/projects/${project.id}/files/${path}`,
          {
            method: "PUT",
            headers: {
              "If-Match": fileContentVersion(original),
              ...(agent && { [AGENT_HEADER]: "agent" }),
            },
            body: "changed",
          },
        );
        expect(embedded.status, `embedded ${path}`).toBe(403);
        expect(await readFile(join(project.path, path), "utf8")).toBe(original);
      }
      await symlink(
        join(project.path, ".claude/settings.local.json"),
        join(project.path, "data.json"),
      );
      const alias = await fixture.app.request(
        `/api/cutroom/projects/${project.id}/source`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            ...(agent && { [AGENT_HEADER]: "agent" }),
          },
          body: JSON.stringify({
            path: "data.json",
            content: "changed",
            expectedVersion: fileContentVersion(original),
          }),
        },
      );
      expect(alias.status).toBe(403);
      expect(
        await readFile(
          join(project.path, ".claude/settings.local.json"),
          "utf8",
        ),
      ).toBe(original);
    } finally {
      await turn.end();
      await editor.dispose();
      await fixture.close();
    }
  });

test("embedded source mutations, renames, and uploads cannot reach protected paths", async () => {
  const fixture = await projectFixture();
  const project = await fixture.store.create({ name: "Embedded boundary" });
  const editor = createHyperframesApi(fixture.store, fixture.review);
  fixture.app.route("/api/editor", editor);
  const original = "original";
  await mkdir(join(project.path, ".git"));
  await writeFile(join(project.path, ".git/config"), original);
  const routes = [
    ["POST", "files/.claude/settings.local.json", {}],
    ["PATCH", "files/index.html", { newPath: "CLAUDE.md" }],
    ["PATCH", "files/index.html", { newPath: "AGENTS.override.md" }],
    ["PATCH", "files/index.html", { newPath: ".claude/settings.local.json" }],
    ["DELETE", "files/.git/config", {}],
    ["POST", "file-mutations/remove-element/.git/config", {}],
    [
      "POST",
      "file-mutations/split-batch",
      { files: [{ path: ".git/config" }] },
    ],
    [
      "POST",
      "file-mutations/patch-element-batches",
      { batches: [{ sourceFile: ".git/config" }] },
    ],
    ["POST", "file-mutations/freeze-frame", { path: ".git/config" }],
    ["POST", "gsap-mutations/.git/config", {}],
    ["POST", "gsap-mutations-batch/.git/config", {}],
    [
      "POST",
      "gsap-mutation-rollback/.git/config",
      { expected: original, restore: "changed" },
    ],
    ["POST", "duplicate-file", { path: ".git/config" }],
    ["PUT", "files/%2egit/config", {}],
    ["PUT", "files/projects/fake/..%2f..%2f.git/config", {}],
  ] as const;
  try {
    for (const [method, route, body] of routes) {
      const response = await fixture.app.request(
        `/api/editor/projects/${project.id}/${route}`,
        {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      expect(response.status, route).toBe(403);
      expect(await readFile(join(project.path, ".git/config"), "utf8")).toBe(
        original,
      );
    }
    const form = new FormData();
    form.append("file", new File(["permission"], "CLAUDE.md"));
    expect(
      (
        await fixture.app.request(`/api/editor/projects/${project.id}/upload`, {
          method: "POST",
          body: form,
        })
      ).status,
    ).toBe(403);
    const hidden = new FormData();
    hidden.append("file", new File(["{}"], "settings.local.json"));
    expect(
      (
        await fixture.app.request(
          `/api/editor/projects/${project.id}/upload?dir=.claude`,
          { method: "POST", body: hidden },
        )
      ).status,
    ).toBe(403);
    expect(await Bun.file(join(project.path, "CLAUDE.md")).exists()).toBe(
      false,
    );
    expect(
      await Bun.file(
        join(project.path, ".claude/settings.local.json"),
      ).exists(),
    ).toBe(false);
  } finally {
    await editor.dispose();
    await fixture.close();
  }
});

test("composition source types, nested source creation, and media file management still work", async () => {
  const fixture = await projectFixture();
  const project = await fixture.store.create({ name: "Editable source" });
  const editor = createHyperframesApi(fixture.store, fixture.review);
  fixture.app.route("/api/editor", editor);
  const turn = await fixture.review.beginTurn(project, {
    kind: "message",
    id: "run",
    token: "agent",
  });
  try {
    for (const path of [
      "styles.css",
      "motion.js",
      "module.mjs",
      "scene.ts",
      "scene.tsx",
      "scene.jsx",
      "module.cjs",
      "data.json",
      "image.svg",
      "scene.htm",
    ]) {
      await writeFile(join(project.path, path), "original");
      for (const agent of [false, true]) {
        const before = await readFile(join(project.path, path), "utf8");
        const response = await fixture.app.request(
          `/api/cutroom/projects/${project.id}/source`,
          {
            method: "PUT",
            headers: {
              "content-type": "application/json",
              ...(agent && { [AGENT_HEADER]: "agent" }),
            },
            body: JSON.stringify({
              path,
              expectedVersion: fileContentVersion(before),
              content: `edited ${agent}`,
            }),
          },
        );
        expect(response.status, path).toBe(200);
        expect(await readFile(join(project.path, path), "utf8")).toBe(
          `edited ${agent}`,
        );
      }
    }
    const created = await fixture.app.request(
      `/api/editor/projects/${project.id}/files/compositions/nested/intro.html`,
      { method: "POST", body: "<main></main>" },
    );
    expect(created.status).toBe(201);
    expect(
      await readFile(
        join(project.path, "compositions/nested/intro.html"),
        "utf8",
      ),
    ).toBe("<main></main>");
    const before = SourceSchema.parse(
      await (await fixture.request(`/projects/${project.id}/source`)).json(),
    );
    expect(
      (
        await fixture.request(`/projects/${project.id}/source`, "PUT", {
          path: "index.html",
          expectedVersion: before.version,
          content: before.content.replace(
            "Drop media in, or ask your agent to start.",
            "Edited composition",
          ),
        })
      ).status,
    ).toBe(200);
    await writeFile(join(project.path, "picture.png"), "fixture image");
    expect(
      (
        await fixture.app.request(
          `/api/editor/projects/${project.id}/files/picture.png`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ newPath: "renamed.png" }),
          },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await fixture.app.request(
          `/api/editor/projects/${project.id}/files/renamed.png`,
          { method: "DELETE" },
        )
      ).status,
    ).toBe(200);
  } finally {
    await turn.end();
    await editor.dispose();
    await fixture.close();
  }
});

test("renaming an asset cannot rewrite a native settings reference", async () => {
  const fixture = await projectFixture();
  const project = await fixture.store.create({ name: "Rename boundary" });
  const editor = createHyperframesApi(fixture.store, fixture.review);
  fixture.app.route("/api/editor", editor);
  try {
    await mkdir(join(project.path, ".claude"));
    const config = '{"permissions":{"allow":["Read(picture.png)"]}}';
    await writeFile(join(project.path, ".claude/settings.local.json"), config);
    await writeFile(join(project.path, "picture.png"), "fixture image");
    const renamed = await fixture.app.request(
      `/api/editor/projects/${project.id}/files/picture.png`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newPath: "Bash.png" }),
      },
    );
    expect(renamed.status).toBe(403);
    expect(
      await readFile(join(project.path, ".claude/settings.local.json"), "utf8"),
    ).toBe(config);
  } finally {
    await editor.dispose();
    await fixture.close();
  }
});

test("undo and restore refuse to rewrite an instruction file", async () => {
  const fixture = await projectFixture();
  const project = await fixture.store.create({ name: "History boundary" });
  try {
    await writeFile(join(project.path, "CLAUDE.md"), "Original permissions");
    const history = await fixture.store.history(project);
    await writeFile(join(project.path, "CLAUDE.md"), "Updated permissions");
    await history.checkpoint();
    const editor = createHyperframesApi(fixture.store, fixture.review);
    fixture.app.route("/api/editor", editor);
    try {
      for (const [path, body] of [
        [`/api/cutroom/projects/${project.id}/history/undo`, {}],
        [
          `/api/editor/projects/${project.id}/history/undo`,
          { entryId: history.list().at(-1)?.id, mode: "just-this" },
        ],
        [
          `/api/editor/projects/${project.id}/history/restore`,
          { point: "start" },
        ],
      ] as const) {
        const response = await fixture.app.request(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(response.status, path).toBe(
          path.startsWith("/api/editor") ? 409 : 403,
        );
        expect(await response.text()).toContain("protected");
      }
    } finally {
      await editor.dispose();
    }
    expect(await readFile(join(project.path, "CLAUDE.md"), "utf8")).toBe(
      "Updated permissions",
    );
  } finally {
    await fixture.close();
  }
});

test("deleting a directory cannot remove its nested agent instructions", async () => {
  const fixture = await projectFixture();
  const project = await fixture.store.create({ name: "Directory boundary" });
  const editor = createHyperframesApi(fixture.store, fixture.review);
  fixture.app.route("/api/editor", editor);
  try {
    await mkdir(join(project.path, "scene"));
    await writeFile(join(project.path, "scene/AGENTS.md"), "Keep permissions");
    const response = await fixture.app.request(
      `/api/editor/projects/${project.id}/files/scene`,
      { method: "DELETE" },
    );
    expect(response.status).toBe(403);
    expect(await readFile(join(project.path, "scene/AGENTS.md"), "utf8")).toBe(
      "Keep permissions",
    );
  } finally {
    await editor.dispose();
    await fixture.close();
  }
});

test("app metadata cannot be symlinked onto native permissions", async () => {
  const fixture = await projectFixture();
  const project = await fixture.store.create({ name: "Metadata alias" });
  try {
    const document = await fixture.store.document(project);
    const settings = JSON.stringify({
      ...document,
      permissions: { deny: ["Bash"] },
    });
    await mkdir(join(project.path, ".claude"));
    await writeFile(
      join(project.path, ".claude/settings.local.json"),
      settings,
    );
    await unlink(join(project.path, "cutroom.json"));
    await symlink(
      join(project.path, ".claude/settings.local.json"),
      join(project.path, "cutroom.json"),
    );
    const add = await fixture.request(
      `/projects/${project.id}/annotations`,
      "POST",
      { kind: "comment", body: "No permission changes", time: 0 },
    );
    expect(add.status).toBe(403);
    expect(
      await readFile(join(project.path, ".claude/settings.local.json"), "utf8"),
    ).toBe(settings);
  } finally {
    await fixture.close();
  }
});
