import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProjectSchema } from "../src/shared/project";
import { expect, test } from "./fixtures";

test("a second position drag survives a controlled document handoff on every frame", async ({
  page,
  request,
}, info) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: {
          name: "Position handoff",
          width: 640,
          height: 360,
          duration: 2,
        },
      })
    ).json(),
  );
  await writeFile(
    join(project.path, "index.html"),
    `<!doctype html><html><head><style>html,body{margin:0;background:#142039}#title{position:absolute;left:60px;top:100px;width:100px;height:50px;background:lime;color:black;font:24px sans-serif}</style></head><body><main id="main" data-composition-id="main" data-width="640" data-height="360" data-fps="30" data-duration="2"><div id="title" class="clip" data-start="0" data-duration="2">Title</div></main></body></html>`,
  );
  // Each opaque document samples its actual subject on rAF. The parent records only the
  // document displayed at that instant, including the first frame after promotion.
  await page.addInitScript(() => {
    if (window === parent) {
      const proof = {
        recording: false,
        samples: [] as { x: number; at: number; document: string }[],
      };
      Object.assign(window, { positionHandoff: proof });
      addEventListener("message", (event) => {
        if (event.data?.source !== "position-handoff-proof" || !proof.recording)
          return;
        const live =
          document.querySelector<HTMLIFrameElement>("iframe[data-live]");
        if (live?.contentWindow === event.source)
          proof.samples.push({
            x: event.data.x,
            at: event.data.at,
            document: live.src,
          });
      });
      return;
    }
    const sample = () => {
      const title = document.getElementById("title");
      if (title)
        parent.postMessage(
          {
            source: "position-handoff-proof",
            x: title.getBoundingClientRect().left,
            at: performance.timeOrigin + performance.now(),
          },
          "*",
        );
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.goto(`/#project/${project.id}`);
  await page.locator('[data-clip="title"]').click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const field = inspector.getByRole("textbox", {
    name: "Position X",
    exact: true,
  });
  const label = inspector.locator("label").filter({ hasText: /^Position X$/ });
  const stage = page.locator(".edit-stage[data-preview-ready]");
  await expect(stage).toBeVisible();
  const box = await label.boundingBox();
  if (!box) throw new Error("Position label missing");
  const x = () =>
    page
      .frameLocator("iframe[data-live]")
      .locator("#title")
      .evaluate((el) => el.getBoundingClientRect().left);
  await expect.poll(x).toBe(60);
  const blocked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let held = false;
  await page.route("**/isolated-preview?*", async (route) => {
    if (!held) {
      held = true;
      blocked.resolve();
      await release.promise;
      await route.continue();
    } else await route.continue();
  });
  await page.mouse.move(box.x + 10, box.y + 5);
  await page.mouse.down();
  await page.mouse.move(box.x + 50, box.y + 5);
  await expect.poll(x).toBe(100);
  await page.mouse.up();
  await blocked.promise;
  await expect(field).toHaveValue("40 px");
  await page.mouse.move(box.x + 10, box.y + 5);
  await page.mouse.down();
  await page.mouse.move(box.x + 70, box.y + 5);
  await expect(field).toHaveValue("100 px");
  await expect.poll(x).toBe(160);
  await page.evaluate(() => {
    (
      window as unknown as { positionHandoff: { recording: boolean } }
    ).positionHandoff.recording = true;
  });
  await page.screenshot({ path: info.outputPath("before-handoff.png") });
  const recording = await page.context().newCDPSession(page);
  const frames: { data: string; timestamp: number }[] = [];
  const acknowledgements: Promise<unknown>[] = [];
  const recordFrame: Parameters<
    typeof recording.on<"Page.screencastFrame">
  >[1] = (frame) => {
    frames.push({ data: frame.data, timestamp: frame.metadata.timestamp ?? 0 });
    acknowledgements.push(
      recording.send("Page.screencastFrameAck", {
        sessionId: frame.sessionId,
      }),
    );
  };
  recording.on("Page.screencastFrame", recordFrame);
  await recording.send("Page.startScreencast", {
    format: "png",
    everyNthFrame: 1,
  });
  release.resolve();
  await expect(stage).toBeVisible();
  // Keep holding across promotion and several real animation frames. A settled assertion
  // alone would miss the one-frame jump that this regression protects against.
  for (let i = 0; i < 6; i++) {
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    await page.screenshot({ path: info.outputPath(`handoff-${i}.png`) });
  }
  await recording.send("Page.stopScreencast");
  recording.off("Page.screencastFrame", recordFrame);
  await Promise.all(acknowledgements);
  await recording.detach();
  for (const [index, frame] of frames.entries())
    await writeFile(
      info.outputPath(`recorded-${index}.png`),
      Buffer.from(frame.data, "base64"),
    );
  await writeFile(
    info.outputPath("recorded-frames.json"),
    JSON.stringify(
      frames.map(({ timestamp }, index) => ({ index, timestamp })),
      null,
      2,
    ),
  );
  const samples = await page.evaluate(() => {
    const proof = (
      window as unknown as {
        positionHandoff: {
          recording: boolean;
          samples: { x: number; at: number; document: string }[];
        };
      }
    ).positionHandoff;
    proof.recording = false;
    return proof.samples;
  });
  await writeFile(
    info.outputPath("handoff-frames.json"),
    JSON.stringify(samples, null, 2),
  );
  expect(new Set(samples.map((sample) => sample.document)).size).toBe(2);
  expect(samples.length).toBeGreaterThan(6);
  expect(
    samples.every((sample) => sample.x === 160),
    JSON.stringify(samples),
  ).toBe(true);
  await expect(field).toHaveValue("100 px");
  await page.mouse.move(box.x + 90, box.y + 5);
  await expect.poll(x).toBe(180);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(field).toHaveValue("40 px");
  await expect.poll(x).toBe(100);
  // Returning held step keys to the saved value must retire the draft too. Otherwise
  // its cached offset would be replayed over the document produced by Undo.
  await field.focus();
  await page.keyboard.down("ArrowUp");
  await page.keyboard.down("ArrowDown");
  await page.keyboard.up("ArrowUp");
  await page.keyboard.up("ArrowDown");
  await field.press("Enter");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(field).toHaveValue("0 px");
  await expect.poll(x).toBe(60);
});
