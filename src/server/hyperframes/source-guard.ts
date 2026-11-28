import type { MiddlewareHandler } from "hono";
import { realpath } from "node:fs/promises";
import { posix, relative } from "node:path";
import type { ProjectStore } from "../projects/store";
import { projectWritePath } from "../projects/path";
import { HttpError } from "../../shared/errors";
import { inFreezeAssets } from "../../shared/media";

/** Uploads are written by HyperFrames' own handler; enforce Cutroom's write boundary before it runs. */
export function uploadGuard(store: ProjectStore): MiddlewareHandler {
  return async (c, next) => {
    const project = await store.get(c.req.param("id") ?? "");
    const root = await realpath(project.path);
    const check = async (path: string) => {
      const absolute = await projectWritePath(project, path, {
        allowMissing: true,
        sourceOnly: false,
      });
      for (const name of [
        posix.normalize(path.replaceAll("\\", "/")),
        relative(root, absolute).replaceAll("\\", "/"),
      ])
        if (inFreezeAssets(name))
          throw new HttpError(
            409,
            "Rename or remove freeze frames in Media to keep their preview and export together.",
          );
    };
    const dir = c.req.query("dir") ?? ".";
    // Validate the directory itself too, including an empty upload into a hidden directory.
    await check(dir);
    const names: string[] = [];
    (await c.req.formData()).forEach((value) => {
      if (typeof value !== "string")
        names.push(value.name.split(/[\\/]/).at(-1) ?? "");
    });
    for (const name of names) await check(`${dir}/${name}`);
    await next();
  };
}
