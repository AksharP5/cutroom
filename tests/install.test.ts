import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installDesktop } from "../scripts/install";

test("desktop installation survives spaces, preserves arguments, clears Electron's CLI mode, and reuses a managed version", async () => {
  const root = await mkdtemp(join(tmpdir(), "cutroom install-"));
  try {
    const source = join(root, "package");
    await mkdir(join(source, "resources/app"), { recursive: true });
    await writeFile(
      join(source, "resources/app/package.json"),
      JSON.stringify({ name: "cutroom", version: "0.1.0" }),
    );
    await writeFile(
      join(source, "cutroom"),
      '#!/bin/sh\nprintf "%s\\n" "${ELECTRON_RUN_AS_NODE-unset}" "$@"\n',
      { mode: 0o755 },
    );
    const options = {
      source,
      dataHome: join(root, "share's folder"),
      binHome: join(root, "bin's folder"),
    };
    const installed = await installDesktop(options);
    expect(await realpath(join(options.dataHome, "cutroom/app/current"))).toBe(
      installed.installed,
    );
    const child = Bun.spawn([installed.executable, "a file.html"], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
        ELECTRON_RUN_AS_NODE: "1",
      },
    });
    expect(await new Response(child.stdout).text()).toBe(
      "unset\na file.html\n",
    );
    expect(await child.exited).toBe(0);
    expect(await installDesktop(options)).toEqual(installed);
    const entry = await readFile(installed.desktop, "utf8");
    expect(entry).toContain("Name=Cutroom");
    expect(entry).toContain('Exec="');
    expect(entry).not.toContain("NoDisplay=true");
    if (Bun.which("desktop-file-validate")) {
      const validation = Bun.spawn(
        ["desktop-file-validate", installed.desktop],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(await new Response(validation.stdout).text()).toBe("");
      expect(await validation.exited).toBe(0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installation refuses an existing unrelated launcher before creating an app install", async () => {
  const root = await mkdtemp(join(tmpdir(), "cutroom-collision-"));
  try {
    const source = join(root, "package");
    await mkdir(join(source, "resources/app"), { recursive: true });
    await writeFile(
      join(source, "resources/app/package.json"),
      JSON.stringify({ name: "cutroom", version: "0.1.0" }),
    );
    await writeFile(join(source, "cutroom"), "#!/bin/sh\n", { mode: 0o755 });
    const binHome = join(root, "bin");
    await mkdir(binHome);
    await writeFile(join(binHome, "cutroom"), "user-owned command");
    await expect(
      installDesktop({ source, dataHome: join(root, "share"), binHome }),
    ).rejects.toThrow("unmanaged file");
    expect(await readFile(join(binHome, "cutroom"), "utf8")).toBe(
      "user-owned command",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
