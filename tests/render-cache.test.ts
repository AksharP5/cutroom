import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  pruneFrameCache,
  renderCacheConfig,
} from "../src/server/hyperframes/renderCache";

test("render work lives in the user's cache directory, outside OS temp", () => {
  const { scratchDir, frameCache } = renderCacheConfig({});
  const cacheRoot = dirname(scratchDir);
  expect(relative(tmpdir(), cacheRoot)).toStartWith(`..${sep}`);
  expect(frameCache.dir).toBe(join(cacheRoot, "frames"));
  expect(frameCache.maxBytes).toBe(2 * 1024 ** 3);
  expect(
    renderCacheConfig({ CUTROOM_EXPORT_CACHE_MB: "12" }).frameCache.maxBytes,
  ).toBe(12 * 1024 ** 2);
  expect(
    renderCacheConfig({ CUTROOM_EXPORT_CACHE_MB: "0" }).frameCache.maxBytes,
  ).toBe(0);
  expect(
    renderCacheConfig({ CUTROOM_EXPORT_CACHE_MB: "-1" }).frameCache.maxBytes,
  ).toBe(frameCache.maxBytes);

  if (process.platform === "linux") {
    const xdg = resolve(homedir(), "xdg-test");
    expect(cacheRoot).toBe(join(homedir(), ".cache", "cutroom"));
    expect(renderCacheConfig({ XDG_CACHE_HOME: xdg }).scratchDir).toBe(
      join(xdg, "cutroom", "scratch"),
    );
    expect(renderCacheConfig({ XDG_CACHE_HOME: "relative" }).scratchDir).toBe(
      scratchDir,
    );
  }
});

test("pruning skips a worker's live cache and evicts the least recently used bytes after it exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "cutroom-cache-test-"));
  const dir = join(root, "frames");
  const oldest = "hfcache-v7-0000000000000001";
  const touched = "hfcache-v8-0000000000000002";
  const partial = `${oldest}.partial-123-abcdef12`;
  const gifs = join(dir, "animated-gif");
  await mkdir(gifs, { recursive: true });
  for (const name of [oldest, touched, partial]) {
    const path = join(dir, name);
    await mkdir(path);
    await writeFile(join(path, "frame_00001.jpg"), Buffer.alloc(8));
    if (name !== partial) {
      const marker = join(path, ".hf-complete");
      await writeFile(marker, "");
      const time = name === oldest ? 1000 : 3000;
      await utimes(marker, time, time);
    }
  }
  const animation = join(gifs, "hfgif-v1-000000000000000000000003.webm");
  await writeFile(animation, Buffer.alloc(8));
  await utimes(animation, 2000, 2000);

  const module = new URL(
    "../src/server/hyperframes/renderCache.ts",
    import.meta.url,
  );
  const owner = Bun.spawn(
    [
      "node",
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `import { lockFrameCache } from ${JSON.stringify(module.href)};
const lock = lockFrameCache(process.argv[1]);
if (!lock) process.exit(1);
console.log("locked");
for await (const chunk of process.stdin) {}
lock.close();`,
      dir,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
  );
  try {
    const reader = owner.stdout.getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(value)).toContain("locked");
    await pruneFrameCache(dir, 16);
    expect((await readdir(dir)).sort()).toEqual(
      ["animated-gif", oldest, touched, partial].sort(),
    );
    owner.kill("SIGKILL");
    await owner.exited;

    await pruneFrameCache(dir, 16);
    expect((await readdir(dir)).sort()).toEqual(["animated-gif", touched]);
    expect(await readdir(gifs)).toHaveLength(1);
    await pruneFrameCache(dir, 8);
    expect(await readdir(gifs)).toEqual([]);
    expect(await readdir(join(dir, touched))).toContain("frame_00001.jpg");
  } finally {
    if (owner.exitCode === null) owner.kill();
    await owner.exited;
    await rm(root, { recursive: true, force: true });
  }
});
