import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { HttpError } from "../src/shared/errors";
import { createProjectRoutes } from "../src/server/projects/routes";
import { createProjectStore } from "../src/server/projects/store";

export async function projectFixture() {
  const directory = await mkdtemp(join(tmpdir(), "cutroom-test-"));
  const store = await createProjectStore({
    dataDir: join(directory, "data"),
    projectsDir: join(directory, "projects"),
  });
  const app = new Hono().route("/api/cutroom", createProjectRoutes(store));
  app.onError((error, c) =>
    c.json(
      { error: error.message },
      error instanceof HttpError ? error.status : 500,
    ),
  );
  const request = (path: string, method = "GET", body?: unknown) =>
    app.request(`/api/cutroom${path}`, {
      method,
      ...(body !== undefined && {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
  return {
    directory,
    store,
    app,
    request,
    async close() {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
