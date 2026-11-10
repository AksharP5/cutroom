import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
if (!existsSync(resolve(root, "dist/index.html"))) {
  const built = Bun.spawn([process.execPath, "run", "build"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await built.exited) !== 0) throw new Error("The editor build failed.");
}
const result = await Bun.build({
  entrypoints: [
    resolve(root, "src/desktop/main.ts"),
    resolve(root, "src/desktop/preload.ts"),
  ],
  outdir: resolve(root, "dist-desktop"),
  naming: "[name].cjs",
  target: "node",
  format: "cjs",
  external: ["electron"],
});
if (!result.success)
  throw new AggregateError(result.logs, "The desktop build failed.");
if (process.argv.includes("--build-only")) process.exit(0);
const child = Bun.spawn(
  [
    process.execPath,
    resolve(root, "node_modules/electron/cli.js"),
    resolve(root, "dist-desktop/main.cjs"),
  ],
  {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      CUTROOM_ROOT: root,
      CUTROOM_BUN_PATH: process.execPath,
      ELECTRON_RUN_AS_NODE: undefined,
    },
  },
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => child.kill(signal));
process.exitCode = await child.exited;
