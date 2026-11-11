import { z } from "zod";
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";
import type { Page } from "puppeteer-core";
import type { FileServerHandle } from "@hyperframes/producer";
import {
  PositionCheckSchema,
  positionCheckFrames,
} from "../../shared/timeline/positionCheck.ts";
import { registerRenderIsolation } from "./renderIsolation.ts";
import type { PositionProducer } from "./renderIsolation.ts";
import { isolateCapturePage } from "./isolation.ts";

interface CheckWindow extends Window {
  __hf: { seek(time: number): void; duration: number };
  __hfPendingScripts?: Set<Promise<void>>;
  __hfFlushSync?: () => void;
  __hfWaitForSeekCompletion?: () => Promise<void>;
}

// Like exports, compilation runs in Node, away from Bun's HTTP globals.
const verify = registerRenderIsolation({}, undefined, true);
const producer = z
  .object({
    createPositionDocument: z.custom<
      PositionProducer["createPositionDocument"]
    >((value) => typeof value === "function"),
  })
  .parse(await import("@hyperframes/producer"));
verify();
const browser = await puppeteer.connect({ browserWSEndpoint: process.argv[2] });
const context = browser
  .browserContexts()
  .find((context) => context.id === process.argv[3]);
if (!context) throw new Error("The Position capture context is unavailable.");
const lines = createInterface({ input: process.stdin });
browser.once("disconnected", () => {
  lines.close();
  process.stdin.destroy();
});
async function check(
  input: ReturnType<typeof PositionCheckSchema.parse>,
  signal: AbortSignal,
) {
  const scratch = await mkdtemp(join(tmpdir(), "cutroom-position-"));
  const documents: { server: FileServerHandle; page?: Page }[] = [];
  let cancelled = false;
  const stop = () => {
    cancelled = true;
    void Promise.all(documents.map((doc) => doc.page?.close().catch(() => {})));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  signal.addEventListener("abort", stop, { once: true });
  try {
    signal.throwIfAborted();
    const frames = positionCheckFrames(input.start, input.end);
    let compiling = Promise.resolve();
    // Offset seeks cost more. Start that document first and overlap its startup
    // with compilation of the unchanged one. Source overrides compile serially.
    const scans = [1, 0].map((i) => {
      const built = compiling.then(() =>
        producer.createPositionDocument(
          input.projectDir,
          resolve(input.projectDir, input.composition),
          input.sources[i]!,
          join(scratch, String(i)),
          input.fps,
          input.overrides,
        ),
      );
      compiling = built.then(
        () => {},
        () => {},
      );
      return built.then(async (server) => {
        const doc: { server: FileServerHandle; page?: Page } = { server };
        documents.push(doc);
        if (cancelled) throw new Error("Position check cancelled.");
        const page = await context!.newPage();
        doc.page = page;
        if (cancelled) throw new Error("Position check cancelled.");
        await isolateCapturePage(page, doc.server.url + "/");
        await page.setViewport({
          width: input.width,
          height: input.height,
          deviceScaleFactor: 1,
        });
        // A seek can insert a late external animation script. Wait for its real load,
        // then seek again, rather than comparing two documents before either ran it.
        await page.evaluateOnNewDocument(() => {
          const win = window as CheckWindow;
          const pending = new Set<Promise<void>>();
          win.__hfPendingScripts = pending;
          const seen = new WeakSet<HTMLScriptElement>();
          const watch = (script: HTMLScriptElement) => {
            if (
              !script.src ||
              seen.has(script) ||
              (script.type &&
                ![
                  "text/javascript",
                  "application/javascript",
                  "module",
                ].includes(script.type.toLowerCase()))
            )
              return;
            seen.add(script);
            const ready = new Promise<void>((done) => {
              script.addEventListener("load", () => done(), { once: true });
              script.addEventListener("error", () => done(), { once: true });
            });
            pending.add(ready);
            void ready.then(() => pending.delete(ready));
          };
          new MutationObserver((records) => {
            for (const record of records)
              for (const node of record.addedNodes) {
                if (node instanceof HTMLScriptElement) watch(node);
                if (node instanceof Element)
                  node.querySelectorAll("script").forEach(watch);
              }
          }).observe(document, { childList: true, subtree: true });
        });
        await page.goto(doc.server.url, { waitUntil: "load", timeout: 20_000 });
        await page.waitForFunction(
          "window.__hf && typeof window.__hf.seek === 'function' && window.__hf.duration > 0",
          { timeout: 20_000, polling: 25 },
        );
        await page.evaluate(() => document.fonts.ready);
        // Startup work can schedule GSAP after render readiness. Wait for a quiet
        // startup window before comparing either document, then drain scripts per seek.
        await page.waitForNetworkIdle({ idleTime: 150, timeout: 20_000 });
        return page.evaluate(
          async ({ frames, clipId, fps }) => {
            const win = window as CheckWindow;
            const matches = document.querySelectorAll(`#${CSS.escape(clipId)}`);
            if (matches.length !== 1) return null;
            const target = matches[0]!;
            const result = [];
            for (const frame of frames) {
              win.__hf.seek((frame * fps.den) / fps.num);
              await win.__hfWaitForSeekCompletion?.();
              if (win.__hfPendingScripts?.size) {
                await Promise.all(win.__hfPendingScripts);
                win.__hfFlushSync?.();
                win.__hf.seek((frame * fps.den) / fps.num);
                await win.__hfWaitForSeekCompletion?.();
              }
              const { x, y, width, height } = target.getBoundingClientRect();
              result.push({ x, y, width, height });
            }
            return result;
          },
          { frames, clipId: input.clipId, fps: input.fps },
        );
      });
    });
    // Wait for both owners before cleanup, even if one compilation/page fails.
    const boxes = (await Promise.allSettled(scans)).map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    const [after, before] = boxes;
    if (!before || !after) return "Position requires a unique clip id.";
    const supported = before.every((box, i) => {
      const shifted = after[i]!;
      return (
        Math.max(
          Math.abs(shifted.x - box.x - 37),
          Math.abs(shifted.y - box.y - 23),
          Math.abs(shifted.width - box.width),
          Math.abs(shifted.height - box.height),
        ) <= 0.5
      );
    });
    return supported ? null : "Position moves differently in this composition.";
  } finally {
    await Promise.all(
      documents.map(async (doc) => {
        await doc.page?.close().catch(() => {});
        doc.server.close();
      }),
    );
    await rm(scratch, { recursive: true, force: true });
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    signal.removeEventListener("abort", stop);
  }
}
const Message = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("check"),
    id: z.string(),
    input: PositionCheckSchema,
  }),
  z.object({ type: z.literal("cancel"), id: z.string() }),
]);
const queue = new Map<string, ReturnType<typeof PositionCheckSchema.parse>>();
let active: { id: string; abort: AbortController } | undefined;
let running: Promise<void> | undefined;
async function drain() {
  while (queue.size) {
    const [id, input] = queue.entries().next().value!;
    queue.delete(id);
    const abort = new AbortController();
    active = { id, abort };
    let result;
    try {
      result = { id, reason: await check(input, abort.signal) };
    } catch (error) {
      result = {
        id,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    process.stdout.write(`CUTROOM_POSITION:${JSON.stringify(result)}\n`);
    active = undefined;
  }
}
try {
  for await (const line of lines) {
    const message = Message.parse(JSON.parse(line));
    if (message.type === "cancel") {
      queue.delete(message.id);
      if (active?.id === message.id) active.abort.abort();
      continue;
    }
    queue.set(message.id, message.input);
    running ??= drain().finally(() => {
      running = undefined;
    });
  }
  await running;
} finally {
  browser.disconnect();
}
