import { spawnSync } from "node:child_process";
import { writeSync } from "node:fs";
import type {
  FullConfig,
  Reporter,
  Suite,
  TestCase,
} from "@playwright/test/reporter";

export default class TeardownWatchdog implements Reporter {
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  onBegin(_config: FullConfig, suite: Suite) {
    this.pending = new Set(suite.allTests().map((test) => test.id));
  }

  onTestBegin(test: TestCase) {
    this.pending.add(test.id);
    clearTimeout(this.timer);
  }

  onTestEnd(test: TestCase) {
    this.pending.delete(test.id);
    if (this.pending.size > 0) return;

    // Playwright calls onEnd only after its workers and web server shut down.
    this.timer = setTimeout(() => {
      const children = spawnSync(
        "ps",
        ["-o", "pid=,ppid=,stat=,comm=", "--ppid", String(process.pid)],
        { encoding: "utf8", timeout: 2_000 },
      );
      const liveChildren = children.stdout
        ?.trim()
        .split("\n")
        .filter(
          (line) => Number(line.trim().split(/\s+/, 1)[0]) !== children.pid,
        )
        .join("\n");
      writeSync(
        2,
        "\nPlaywright still running 60 seconds after the last test finished.\n" +
          `Active Node resources: ${process.getActiveResourcesInfo().join(", ")}\n` +
          `Direct child processes (PID, PPID, state, command):\n${liveChildren || "(none found)"}\n`,
      );
      process.exit(1);
    }, 60_000).unref();
  }
}
