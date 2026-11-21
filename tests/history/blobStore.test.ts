// Copyright 2026 HeyGen, Inc.
// SPDX-License-Identifier: Apache-2.0
// Adapted from HyperFrames v0.9.26 (Apache-2.0). See THIRD_PARTY_NOTICES.md.

import { beforeEach, afterEach, describe, expect, it } from "bun:test";
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveWhileOpen } from "@hyperframes/studio-server/history-host";
import { openBlobStore } from "../../src/server/history/blobStore";

describe("a restore of a file the preview is serving", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hf-blob-served-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("ends the preview's open read of it first, which Windows would not replace", async () => {
    const target = join(root, "clip.mp4");
    writeFileSync(target, Buffer.alloc(1 << 20, 1));
    const store = await openBlobStore(join(root, "history", "blobs"));
    const hash = await store.put(target);
    const read = serveWhileOpen(
      target,
      createReadStream(target, { highWaterMark: 1024 }),
    );
    await new Promise((resolve) => read.once("data", resolve));
    read.pause();
    await store.writeTo(hash, target, () => expect(read.closed).toBe(true));
  });
});

describe("the history store's count of what it holds", () => {
  it("counts a file once when two copies of it are filed together", async () => {
    const root = mkdtempSync(join(tmpdir(), "hf-blob-count-"));
    try {
      const small = join(root, "small.txt");
      const large = join(root, "large.txt");
      writeFileSync(small, "same bytes");
      writeFileSync(large, "x".repeat(200 * 1024));
      const store = await openBlobStore(join(root, "history", "blobs"));
      await Promise.all([
        store.put(small),
        store.put(small),
        store.put(large),
        store.put(large),
      ]);
      expect(store.bytes()).toBe("same bytes".length + 200 * 1024);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
