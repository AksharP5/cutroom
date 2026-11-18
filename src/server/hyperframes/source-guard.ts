import type { MiddlewareHandler } from "hono";
import { existsSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { join, posix, relative } from "node:path";
import {
  requestSubPath,
  STUDIO_SIGNATURE_MANIFEST_PATHS,
} from "@hyperframes/studio-server";
import { isPrivateProjectFile } from "@hyperframes/studio-server/safe-path";
import { z } from "zod";
import type { ProjectStore } from "../projects/store";
import { projectStatePath, projectWritePath } from "../projects/path";
import { REVIEW_STATE_PATH } from "../../shared/review";
import { LEDGER_PATH } from "../projects/ids";
import { HttpError } from "../../shared/errors";
import { FREEZE_DIR, inFreezeAssets } from "../../shared/media";

const stateFiles = new Set([
  REVIEW_STATE_PATH,
  LEDGER_PATH,
  ...STUDIO_SIGNATURE_MANIFEST_PATHS,
  ".media/manifest.jsonl",
]);

/** The embedded editor has its own writers; enforce Cutroom's boundary before entering them. */
export function sourceWriteGuard(store: ProjectStore): MiddlewareHandler {
  return async (c, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
    const route = requestSubPath(c.req.url, "projects/:id");
    const [family, action] = route.split("/");
    if (
      ![
        "files",
        "file-mutations",
        "gsap-mutations",
        "gsap-mutations-batch",
        "gsap-mutation-rollback",
        "duplicate-file",
        "upload",
      ].includes(family ?? "")
    )
      return next();
    const project = await store.get(c.req.param("id") ?? "");
    const check = (path: string, sourceOnly = true) =>
      projectWritePath(project, path, { allowMissing: true, sourceOnly });
    const checkFreezePaths = async (
      path: string,
      absolute: string,
      tree = false,
    ) => {
      const root = await realpath(project.path);
      for (const name of [
        posix.normalize(path.replaceAll("\\", "/")),
        relative(root, absolute).replaceAll("\\", "/"),
      ]) {
        if (
          inFreezeAssets(name) ||
          (tree &&
            (name === "" || FREEZE_DIR.startsWith(`${name}/`)) &&
            existsSync(join(root, FREEZE_DIR)))
        )
          throw new HttpError(
            409,
            "Rename or remove freeze frames in Media to keep their preview and export together.",
          );
      }
    };
    const bodyPath = z.object({ path: z.string() });
    if (family === "files") {
      const file = requestSubPath(c.req.url, "projects/:id/files");
      const moveOrDelete = ["PATCH", "DELETE"].includes(c.req.method);
      const absolute = await check(file, !moveOrDelete);
      await checkFreezePaths(file, absolute, moveOrDelete);
      if (c.req.method === "PATCH") {
        const { newPath } = z
          .object({ newPath: z.string() })
          .parse(await c.req.json());
        await checkFreezePaths(newPath, await check(newPath, false));
        // Upstream rename rewrites references in all these text files, including native settings.
        // Refuse that operation if its broad writer could reach protected content.
        const directories = [""];
        for (const directory of directories) {
          for (const entry of await readdir(join(project.path, directory), {
            withFileTypes: true,
          })) {
            const path = directory ? `${directory}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
              if (
                ![
                  "node_modules",
                  ".thumbnails",
                  "renders",
                  ".transcode-cache",
                ].includes(entry.name)
              )
                directories.push(path);
            } else if (
              /\.(html|css|js|jsx|ts|tsx|json|mjs|cjs|md|mdx)$/i.test(
                entry.name,
              )
            ) {
              if (isPrivateProjectFile(project.path, join(project.path, path)))
                continue;
              if (stateFiles.has(path)) await projectStatePath(project, path);
              else await check(path, false);
            }
          }
        }
      }
      if (c.req.method === "DELETE" && (await stat(absolute)).isDirectory()) {
        const directories = [file];
        for (const directory of directories) {
          for (const entry of await readdir(join(project.path, directory), {
            withFileTypes: true,
          })) {
            const path = `${directory}/${entry.name}`;
            await check(path, false);
            if (entry.isDirectory()) directories.push(path);
          }
        }
      }
    } else if (family === "file-mutations" && action === "split-batch") {
      const { files } = z
        .object({ files: z.array(bodyPath) })
        .parse(await c.req.json());
      for (const file of files) await check(file.path);
    } else if (
      family === "file-mutations" &&
      action === "patch-element-batches"
    ) {
      const { batches } = z
        .object({ batches: z.array(z.object({ sourceFile: z.string() })) })
        .parse(await c.req.json());
      for (const batch of batches) await check(batch.sourceFile);
    } else if (
      family === "duplicate-file" ||
      (family === "file-mutations" && action === "freeze-frame")
    ) {
      const { path } = bodyPath.parse(await c.req.json());
      const absolute = await check(path, family !== "duplicate-file");
      if (family === "duplicate-file") await checkFreezePaths(path, absolute);
    } else if (family === "upload") {
      const dir = c.req.query("dir") ?? ".";
      // Validate the directory itself too, including an empty upload into a hidden directory.
      await checkFreezePaths(dir, await check(dir, false));
      const paths: string[] = [];
      (await c.req.formData()).forEach((value) => {
        if (typeof value === "string") return;
        const name = value.name.split(/[\\/]/).at(-1) ?? "";
        paths.push(`${dir}/${name}`);
      });
      for (const path of paths)
        await checkFreezePaths(path, await check(path, false));
    } else {
      const prefix =
        family === "file-mutations" ? `${family}/${action}` : family;
      await check(requestSubPath(c.req.url, `projects/:id/${prefix}`));
    }
    await next();
  };
}
