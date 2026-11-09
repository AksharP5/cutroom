import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";

if (process.platform !== "linux")
  throw new Error(
    "The portable package currently targets Linux. Use bun run desktop on this platform.",
  );
const root = resolve(import.meta.dir, "..");
const value: unknown = await Bun.file(join(root, "package.json")).json();
const manifest = z
  .object({ version: z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/) })
  .passthrough()
  .parse(value);
const name = `cutroom-${manifest.version}-linux-${process.arch}`;
const release = join(root, "release");
await mkdir(release, { recursive: true });
const stage = await mkdtemp(join(release, ".package-"));
const app = join(stage, "resources", "app");
const runtime = join(stage, "resources", "runtime");

async function run(args: string[], cwd = root) {
  const child = Bun.spawn(args, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: "1" },
  });
  if ((await child.exited) !== 0)
    throw new Error(`Packaging failed while running ${args[1] ?? args[0]}.`);
}

try {
  await run([process.execPath, "run", "build"]);
  await run([process.execPath, "scripts/desktop.ts", "--build-only"]);
  await cp(join(root, "node_modules", "electron", "dist"), stage, {
    recursive: true,
  });
  await rm(join(stage, "resources", "default_app.asar"), { force: true });
  await mkdir(app, { recursive: true });
  await mkdir(join(app, "desktop"));
  await cp(
    join(root, "dist-desktop", "main.cjs"),
    join(app, "desktop", "main.cjs"),
  );
  await cp(join(root, "dist"), join(app, "dist"), { recursive: true });
  await cp(join(root, "src", "server"), join(app, "src", "server"), {
    recursive: true,
  });
  await cp(join(root, "src", "shared"), join(app, "src", "shared"), {
    recursive: true,
  });
  await mkdir(join(app, "src", "desktop"), { recursive: true });
  await cp(
    join(root, "src", "desktop", "icon.png"),
    join(app, "src", "desktop", "icon.png"),
  );
  await writeFile(
    join(app, "package.json"),
    `${JSON.stringify({ ...manifest, main: "desktop/main.cjs" }, null, 2)}\n`,
  );
  await cp(join(root, "bun.lock"), join(app, "bun.lock"));
  await run(
    [
      process.execPath,
      "install",
      "--production",
      "--frozen-lockfile",
      "--ignore-scripts",
    ],
    app,
  );
  // The core SDK is kept intact; optional platform runtimes are unused because users supply their CLI.
  const anthropic = join(app, "node_modules", "@anthropic-ai");
  for (const entry of await readdir(anthropic, { withFileTypes: true })) {
    if (entry.name.startsWith("claude-agent-sdk-"))
      await rm(join(anthropic, entry.name), { recursive: true, force: true });
  }
  for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md", "README.md"])
    await cp(join(root, file), join(app, file));
  await cp(join(root, "licenses"), join(app, "licenses"), { recursive: true });
  await cp(join(root, "docs"), join(app, "docs"), { recursive: true });
  await mkdir(join(runtime, "bin"), { recursive: true });
  await cp(await realpath(process.execPath), join(runtime, "bin", "bun"));
  const nodeResult = Bun.spawnSync(["node", "-p", "process.execPath"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (nodeResult.exitCode !== 0)
    throw new Error(
      "Node.js 22.18 or newer is required to package the render worker.",
    );
  const node = await realpath(nodeResult.stdout.toString().trim());
  const nodeVersion = Bun.spawnSync([node, "-p", "process.versions.node"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [major, minor] = nodeVersion.stdout
    .toString()
    .trim()
    .split(".")
    .map(Number);
  if (
    nodeVersion.exitCode !== 0 ||
    !major ||
    major < 22 ||
    (major === 22 && (minor ?? 0) < 18)
  )
    throw new Error(
      "Node.js 22.18 or newer is required to package the render worker.",
    );
  await cp(node, join(runtime, "bin", "node"));
  const nodeLicense = join(dirname(node), "..", "LICENSE");
  if (
    await stat(nodeLicense).then(
      (entry) => entry.isFile(),
      () => false,
    )
  )
    await cp(nodeLicense, join(runtime, "NODE-LICENSE.txt"));
  await rename(join(stage, "electron"), join(stage, "cutroom"));
  await writeFile(
    join(stage, "START.txt"),
    "Open ./cutroom to start the studio. Bun and Node are included. FFmpeg and Chromium must be installed for local video exports. Codex and Claude Code use your own installed runtimes and sign-in. Projects and credentials are not included in this package.\n",
  );
  const output = join(release, name);
  await rm(output, { recursive: true, force: true });
  await rename(stage, output);
  const archive = `${output}.tar.gz`;
  await run(["tar", "-czf", archive, "-C", release, basename(output)]);
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(archive).stream()) hash.update(chunk);
  await writeFile(
    `${archive}.sha256`,
    `${hash.digest("hex")}  ${basename(archive)}\n`,
  );
  console.log(
    `Portable folder: ${output}\nArchive: ${archive}\nChecksum: ${archive}.sha256`,
  );
} catch (error) {
  await rm(stage, { recursive: true, force: true });
  throw error;
}
