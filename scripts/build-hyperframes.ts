import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import core from "../vendor/hyperframes/packages/core/package.json";
import engine from "../vendor/hyperframes/packages/engine/package.json";
import lint from "../vendor/hyperframes/packages/lint/package.json";
import parsers from "../vendor/hyperframes/packages/parsers/package.json";
import producer from "../vendor/hyperframes/packages/producer/package.json";
import studioServer from "../vendor/hyperframes/packages/studio-server/package.json";

// Producer packages the modular runtime from core's dist. The declaration
// bundlers build against workspace sources and can run in the same phase.
const phases = [[parsers, lint, studioServer], [core], [engine, producer]];
const packages = phases.flat();
const root = resolve(import.meta.dir, "..");
const source = join(root, "vendor", "hyperframes");
const output = join(root, "vendor", "@hyperframes");
const scratch = join(root, ".cutroom-dev");
const markerPath = join(output, ".build-id");
const marker = Bun.file(markerPath);
const patchDir = join(root, "patches");
const patches = new Map(
  [...new Bun.Glob("@hyperframes*.patch").scanSync(patchDir)].map((file) => [
    decodeURIComponent(file).replace("+", "/").slice(0, -".patch".length),
    join(patchDir, file),
  ]),
);
const generated = new Set(["dist", "docs", "schemas", "LICENSE", "README.md"]);

const env = { ...process.env };
delete env.SANDBOX_RUNTIME_VARIANT;
delete env.HYPERFRAME_RUNTIME_BUILD_ID;
delete env.HYPERFRAME_RUNTIME_VERSION;

function run(args: string[], cwd: string, commandEnv = env) {
  const result = Bun.spawnSync(args, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    env: commandEnv,
  });
  if (result.exitCode !== 0)
    throw new Error(`${args.join(" ")} failed in ${cwd}`);
}

function sourceInput(path: string) {
  return !path
    .split(/[\\/]/)
    .some((part) => part === "node_modules" || part === "dist");
}

async function buildId() {
  const hash = createHash("sha256");
  hash.update(`${Bun.version}/${process.platform}/${process.arch}\0`);
  const paths = [
    import.meta.path,
    ...[...new Bun.Glob("**/*").scanSync({ cwd: source, dot: true })]
      .filter(sourceInput)
      .map((path) => join(source, path)),
    ...patches.values(),
    ...packages.map(({ name }) => join(output, basename(name), "package.json")),
  ];
  for (const path of paths.sort()) {
    hash.update(relative(root, path));
    hash.update("\0");
    hash.update(await Bun.file(path).bytes());
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function build() {
  const updateManifests = process.argv.includes("--update-manifests");
  for (const spec of patches.keys()) {
    if (!packages.some(({ name, version }) => spec === `${name}@${version}`))
      throw new Error(`No matching HyperFrames package for the ${spec} patch`);
  }
  const id = updateManifests ? undefined : await buildId();
  if (
    id &&
    (await marker.exists()) &&
    (await marker.text()) === id &&
    (
      await Promise.all(
        packages.map(({ name }) =>
          Bun.file(join(output, basename(name), "dist", "index.js")).exists(),
        ),
      )
    ).every(Boolean)
  ) {
    console.log("HyperFrames packages are up to date.");
    return;
  }

  await mkdir(scratch, { recursive: true });
  const stage = await mkdtemp(join(scratch, "hyperframes-"));
  const workspace = join(stage, "source");
  const stagedFiles = new Map<string, string[]>();
  try {
    if (!updateManifests) {
      await cp(source, workspace, {
        recursive: true,
        filter: (path) => sourceInput(relative(source, path)),
      });
      run(
        [process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"],
        workspace,
      );
      for (const phase of phases) {
        run(
          [
            process.execPath,
            "run",
            ...phase.flatMap(({ name }) => ["--filter", name]),
            "build",
          ],
          workspace,
        );
      }
    }

    for (const sourceManifest of packages) {
      const {
        publishConfig,
        dependencies,
        devDependencies,
        scripts,
        "x-cutroom-modified": changeNotice,
        ...manifest
      } = { "x-cutroom-modified": undefined, ...sourceManifest };
      const name = basename(manifest.name);
      const target = join(output, name, "package.json");
      const packageStage = join(stage, name, "package");
      const { access, registry, ...published } = {
        registry: undefined,
        ...publishConfig,
      };
      const runtimeManifest = {
        ...manifest,
        ...published,
        publishConfig: { access, registry },
        dependencies: Object.fromEntries(
          Object.entries(dependencies).map(([dependency, spec]) => [
            dependency,
            spec === "workspace:*"
              ? manifest.version
              : spec.replace("workspace:^", `^${manifest.version}`),
          ]),
        ),
      };
      if (updateManifests) {
        await mkdir(packageStage, { recursive: true });
      } else {
        const archive = join(stage, `${name}.tar`);
        run(
          [
            process.execPath,
            "pm",
            "pack",
            "--quiet",
            "--ignore-scripts",
            "--gzip-level",
            "0",
            "--filename",
            archive,
          ],
          join(workspace, "packages", name),
        );
        await new Bun.Archive(await Bun.file(archive).bytes()).extract(
          join(stage, name),
        );
        await cp(join(source, "LICENSE"), join(packageStage, "LICENSE"));
      }
      await Bun.write(
        join(packageStage, "package.json"),
        `${JSON.stringify(runtimeManifest, null, 2)}\n`,
      );
      const patch = patches.get(`${manifest.name}@${manifest.version}`);
      if (patch) {
        run(
          [
            "git",
            "apply",
            ...(updateManifests
              ? ["--include=package.json", "--allow-empty"]
              : []),
            patch,
          ],
          packageStage,
          { ...env, GIT_CEILING_DIRECTORIES: stage },
        );
      }
      const expected = Bun.file(join(packageStage, "package.json"));
      if (updateManifests) {
        await Bun.write(target, expected);
      } else if ((await expected.text()) !== (await Bun.file(target).text())) {
        throw new Error(
          `${target} differs from the built manifest. Run bun run build:hyperframes --update-manifests.`,
        );
      }
      if (updateManifests) continue;
      const files = (await readdir(packageStage)).filter(
        (file) => file !== "package.json",
      );
      for (const file of files) {
        if (!generated.has(file))
          throw new Error(`Unexpected packaged file: ${name}/${file}`);
      }
      stagedFiles.set(name, files);
    }
    if (!id) return;

    // Keep the workspace manifests and Bun's own nested dependency links in place.
    await rm(markerPath, { force: true });
    for (const [name, files] of stagedFiles) {
      const target = join(output, name);
      const packageStage = join(stage, name, "package");
      for (const file of generated)
        await rm(join(target, file), { recursive: true, force: true });
      for (const file of files)
        await rename(join(packageStage, file), join(target, file));
    }
    await Bun.write(marker, id);
    console.log("Built HyperFrames packages from vendored source.");
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

await build();
