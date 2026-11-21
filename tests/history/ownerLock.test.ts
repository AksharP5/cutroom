// Copyright 2026 HeyGen, Inc.
// SPDX-License-Identifier: Apache-2.0
// Adapted from HyperFrames v0.9.26 (Apache-2.0). See THIRD_PARTY_NOTICES.md.

import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, uptime } from "node:os";
import { join } from "node:path";
import {
  HistoryBusyError,
  processStart,
  takeHistoryOwnership,
} from "../../src/server/history/ownerLock";

const homes: string[] = [];
function newHome() {
  const home = mkdtempSync(join(tmpdir(), "hf-history-owner-"));
  homes.push(home);
  return home;
}
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

const startable =
  process.platform !== "win32" && processStart(process.ppid) !== null;

describe.skipIf(!startable)(
  "takeHistoryOwnership when a pid has been reused",
  () => {
    const stamp = (home: string, pid: number, start: string) =>
      writeFileSync(join(home, "owner.pid.start"), `${pid}\n${start}`);

    it("takes over a lock whose pid now runs a different process", async () => {
      const home = newHome();
      writeFileSync(join(home, "owner.pid"), String(process.ppid));
      stamp(home, process.ppid, "Thu Jan  1 00:00:00 1970");
      const release = await takeHistoryOwnership(home, 100);
      expect(readFileSync(join(home, "owner.pid"), "utf-8")).toBe(
        String(process.pid),
      );
      release();
      expect(existsSync(join(home, "owner.pid.start"))).toBe(false);
    });

    it("holds while the live owner is the process that took the lock", async () => {
      const home = newHome();
      writeFileSync(join(home, "owner.pid"), String(process.ppid));
      stamp(home, process.ppid, processStart(process.ppid)!);
      await expect(takeHistoryOwnership(home, 100)).rejects.toThrow(
        HistoryBusyError,
      );
    });

    it.skipIf(processStart(1) === null)(
      "holds a live owner this user may not signal when its start time matches",
      async () => {
        const home = newHome();
        writeFileSync(join(home, "owner.pid"), "1");
        stamp(home, 1, processStart(1)!);
        await expect(takeHistoryOwnership(home, 100)).rejects.toThrow(
          HistoryBusyError,
        );
      },
    );

    it.skipIf(processStart(1) === null)(
      "takes over a lock whose pid is a process this user may not signal, once its start time differs",
      async () => {
        const home = newHome();
        writeFileSync(join(home, "owner.pid"), "1");
        stamp(home, 1, "Thu Jan  1 00:00:00 1970");
        const release = await takeHistoryOwnership(home, 100);
        expect(readFileSync(join(home, "owner.pid"), "utf-8")).toBe(
          String(process.pid),
        );
        release();
      },
    );

    it("takes over a lock without a recorded start that was written before the machine booted", async () => {
      const home = newHome();
      const lock = join(home, "owner.pid");
      writeFileSync(lock, String(process.ppid));
      const beforeBoot = new Date(Date.now() - (uptime() + 3_600) * 1000);
      utimesSync(lock, beforeBoot, beforeBoot);
      const release = await takeHistoryOwnership(home, 100);
      expect(readFileSync(lock, "utf-8")).toBe(String(process.pid));
      release();
    });
  },
);
