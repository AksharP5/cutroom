import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";

const appSchema = z.object({
  name: z.literal("cutroom"),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/),
});
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const managedScript = "#!/bin/sh\n# Managed by Cutroom.\n";

async function writeInstalledFile(path: string, content: string, mode = 0o644) {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function requireManagedFile(path: string, marker: string) {
  const content = await readFile(path, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  });
  if (content !== undefined && !content.includes(marker))
    throw new Error(`Refusing to replace an unmanaged file: ${path}`);
}

export async function installDesktop(options: {
  source: string;
  dataHome?: string;
  binHome?: string;
}) {
  if (process.platform !== "linux")
    throw new Error("Desktop launcher installation currently supports Linux.");
  const source = resolve(options.source);
  const manifest = appSchema.parse(
    JSON.parse(
      await readFile(join(source, "resources/app/package.json"), "utf8"),
    ),
  );
  const executable = join(source, "cutroom");
  if (!(await lstat(executable)).isFile())
    throw new Error("The package needs a cutroom executable.");
  const dataHome = resolve(
    options.dataHome ??
      process.env.XDG_DATA_HOME ??
      join(homedir(), ".local/share"),
  );
  const binHome = resolve(options.binHome ?? join(homedir(), ".local/bin"));
  const installRoot = join(dataHome, "cutroom/app");
  const destination = join(installRoot, manifest.version);
  const current = join(installRoot, "current");
  const wrapper = join(binHome, "cutroom");
  const desktop = join(
    dataHome,
    "applications/io.github.AksharP5.Cutroom.desktop",
  );
  await requireManagedFile(wrapper, managedScript);
  await requireManagedFile(desktop, "X-Cutroom-Managed=true");
  const currentInfo = await lstat(current).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  });
  if (
    currentInfo &&
    (!currentInfo.isSymbolicLink() ||
      dirname(resolve(installRoot, await readlink(current))) !== installRoot)
  )
    throw new Error(`Refusing to replace an unmanaged install: ${current}`);
  await mkdir(installRoot, { recursive: true });
  const installed = await lstat(destination).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  });
  if (installed) {
    if (!installed.isDirectory())
      throw new Error(`Refusing to reuse an unmanaged install: ${destination}`);
    const marker = appSchema.parse(
      JSON.parse(
        await readFile(join(destination, ".cutroom-install.json"), "utf8"),
      ),
    );
    if (marker.version !== manifest.version)
      throw new Error(`Installed version does not match ${manifest.version}.`);
  }
  if (!installed) {
    const stage = await mkdtemp(join(installRoot, ".install-"));
    try {
      await cp(source, stage, { recursive: true });
      await writeFile(
        join(stage, ".cutroom-install.json"),
        JSON.stringify(manifest),
      );
      await rename(stage, destination);
    } catch (error) {
      await rm(stage, { recursive: true, force: true });
      throw error;
    }
  }
  const link = join(installRoot, `.current-${crypto.randomUUID()}`);
  await symlink(basename(destination), link);
  await rename(link, current);
  await mkdir(binHome, { recursive: true });
  await mkdir(dirname(desktop), { recursive: true });
  await writeInstalledFile(
    wrapper,
    `${managedScript}unset ELECTRON_RUN_AS_NODE\nexec ${shellQuote(join(current, "cutroom"))} "$@"\n`,
    0o755,
  );
  await chmod(wrapper, 0o755);
  const execPath = wrapper
    .replaceAll("%", "%%")
    .replace(/[\\"$`]/g, (character) => `\\${character}`)
    .replaceAll("\\", "\\\\");
  const icon = join(current, "resources/app/src/desktop/icon.png").replaceAll(
    "\\",
    "\\\\",
  );
  await writeInstalledFile(
    desktop,
    `[Desktop Entry]\nVersion=1.0\nType=Application\nName=Cutroom\nComment=Local video studio with native agents\nExec="${execPath}"\nIcon=${icon}\nTerminal=false\nCategories=AudioVideo;Video;AudioVideoEditing;\nKeywords=video;studio;editor;motion;agents;\nStartupWMClass=cutroom\nStartupNotify=true\nX-Cutroom-Managed=true\n`,
  );
  const updater = Bun.which("update-desktop-database");
  if (updater) {
    const process = Bun.spawn([updater, dirname(desktop)], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const message = await new Response(process.stderr).text();
    if ((await process.exited) !== 0)
      throw new Error(
        `Installed Cutroom, but the desktop cache could not refresh: ${message}`,
      );
  }
  return {
    version: manifest.version,
    executable: wrapper,
    desktop,
    installed: destination,
  };
}

if (import.meta.main) {
  const argument = process.argv.indexOf("--from");
  const source = argument >= 0 ? process.argv[argument + 1] : undefined;
  if (argument >= 0 && !source)
    throw new Error("--from requires a portable package folder.");
  const root = resolve(import.meta.dir, "..");
  const manifest = appSchema.parse(
    await Bun.file(join(root, "package.json")).json(),
  );
  const installed = await installDesktop({
    source:
      source ??
      join(root, `release/cutroom-${manifest.version}-linux-${process.arch}`),
  });
  console.log(
    `Installed Cutroom ${installed.version}. Find Cutroom in your application launcher.\n${installed.executable}`,
  );
}
