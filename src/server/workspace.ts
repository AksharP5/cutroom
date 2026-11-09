import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { constants } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { version } from "../shared/version";
import { HttpError } from "../shared/errors";
import type { ProjectStore } from "./projects/store";
import { projectPath } from "./projects/store";

export function createWorkspaceRoutes(options: {
  projects: ProjectStore;
  dataDir: string;
  projectsDir: string;
  mcpCommand: string;
}) {
  const app = new Hono();
  app.get("/status", (c) =>
    c.json({
      version,
      dataDir: options.dataDir,
      projectsDir: options.projectsDir,
      mcpCommand: options.mcpCommand,
    }),
  );
  app.get("/browse", async (c) => {
    const input = c.req.query("path") || options.projectsDir;
    if (!input.startsWith("/"))
      throw new HttpError(400, "Enter an absolute folder path.");
    const path = await realpath(resolve(input)).catch(() => {
      throw new HttpError(404, "That folder is unavailable.");
    });
    const info = await stat(path);
    if (!info.isDirectory())
      throw new HttpError(400, "Choose a folder to browse.");
    const items = await readdir(path, { withFileTypes: true });
    const entries = await Promise.all(
      items
        .filter(
          (item) =>
            !item.name.startsWith(".") &&
            (item.isDirectory() || item.isFile() || item.isSymbolicLink()),
        )
        .map(async (item) => {
          const target = join(path, item.name);
          const info = await stat(target).catch(() => null);
          return info
            ? {
                name: item.name,
                path: target,
                directory: info.isDirectory(),
                size: info.size,
              }
            : null;
        }),
    );
    return c.json({
      path,
      parent: dirname(path),
      entries: entries
        .filter((item) => item !== null)
        .sort(
          (a, b) =>
            Number(b.directory) - Number(a.directory) ||
            a.name.localeCompare(b.name, undefined, { numeric: true }),
        ),
    });
  });
  app.post("/projects/:id/attachments", async (c) => {
    if (Number(c.req.header("content-length") ?? 0) > 20_000_000)
      throw new HttpError(400, "The image is too large.");
    const body = z
      .object({
        image: z
          .string()
          .max(20_000_000)
          .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/),
      })
      .parse(await c.req.json());
    const project = await options.projects.get(c.req.param("id"));
    const bytes = Buffer.from(
      body.image.slice(body.image.indexOf(",") + 1),
      "base64",
    );
    if (
      !bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new HttpError(400, "The attachment must be a PNG image.");
    const cutroom = await projectPath(project, ".cutroom", true);
    await mkdir(cutroom, { recursive: true });
    const directory = await projectPath(project, ".cutroom/attachments", true);
    await mkdir(directory, { recursive: true });
    const path = await projectPath(
      project,
      `.cutroom/attachments/${randomUUID()}.png`,
      true,
    );
    await writeFile(path, bytes, { flag: "wx" });
    return c.json({ path }, 201);
  });
  app.post("/projects/:id/attachments/import", async (c) => {
    const input = z
      .object({
        path: z.string().refine(isAbsolute, "Choose an absolute file path."),
      })
      .parse(await c.req.json());
    const project = await options.projects.get(c.req.param("id"));
    const source = await realpath(input.path);
    const info = await stat(source);
    if (!info.isFile()) throw new HttpError(400, "Choose a regular file.");
    const local = relative(project.path, source);
    if (local !== ".." && !local.startsWith("../") && !isAbsolute(local))
      return c.json({ path: source });
    if (info.size > 50 * 1024 * 1024)
      throw new HttpError(
        400,
        "Attachments outside the project must be smaller than 50 MB. Add larger media to the project folder first.",
      );
    for (const folder of [".cutroom", ".cutroom/attachments"])
      await mkdir(await projectPath(project, folder, true), {
        recursive: true,
      });
    const folder = await projectPath(
      project,
      `.cutroom/attachments/${randomUUID()}`,
      true,
    );
    await mkdir(folder);
    const path = join(folder, basename(source));
    await copyFile(source, path, constants.COPYFILE_EXCL);
    return c.json({ path }, 201);
  });
  app.get("/projects/:id/attachments/:file", async (c) => {
    const file = z
      .string()
      .uuid()
      .parse(c.req.param("file").replace(/\.png$/, ""));
    const project = await options.projects.get(c.req.param("id"));
    const path = await projectPath(project, `.cutroom/attachments/${file}.png`);
    return new Response(Bun.file(path), {
      headers: {
        "content-type": "image/png",
        "cache-control": "private, max-age=86400",
      },
    });
  });
  app.get("/projects/:id/events", async (c) => {
    const project = await options.projects.get(c.req.param("id"));
    return streamSSE(c, async (stream) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const watcher = watch(
        project.path,
        { recursive: true },
        (_event, filename) => {
          if (
            !filename ||
            filename
              .split(/[\\/]/)
              .some((part) => part.startsWith(".") || part === "node_modules")
          )
            return;
          if (filename !== "cutroom.json" && !/\.html?$/i.test(filename))
            return;
          clearTimeout(timer);
          timer = setTimeout(() => {
            void stream
              .writeSSE({ data: JSON.stringify({ changed: filename }) })
              .catch(() => {});
          }, 100);
        },
      );
      const heartbeat = setInterval(() => {
        void stream.writeSSE({ event: "ping", data: "" }).catch(() => {});
      }, 20_000);
      try {
        await stream.writeSSE({ event: "ready", data: "{}" });
        if (!stream.aborted)
          await new Promise<void>((done) => stream.onAbort(done));
      } finally {
        watcher.close();
        clearTimeout(timer);
        clearInterval(heartbeat);
      }
    });
  });
  return app;
}
