import { ProjectSchema } from "../src/shared/project";
import { NotebookSchema } from "../src/shared/review";
import { agentTurn, playSession } from "./agent-turn";
import { expect, test } from "./fixtures";

test("a drawing waits in chat and Send now carries its captured frame", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Review notes in chat" },
      })
    ).json(),
  );
  const { ask, reply, session } = agentTurn(project.id);
  const chat = session([ask, reply], "idle");
  await playSession(page, [chat]);
  const base = `/api/cutroom/projects/${project.id}`;
  await page.route(`**/agents/sessions/${chat.id}/turns`, async (route) => {
    const notebook = NotebookSchema.parse(
      await (await request.get(`${base}/notebook`)).json(),
    );
    for (const note of notebook.items)
      await request.post(`${base}/review/${note.id}/human`, {
        data: { type: "withdraw", reason: "Synthetic turn finished" },
      });
    await route.fulfill({ status: 202, json: chat });
  });

  let releaseCapture = () => {};
  const capture = new Promise<void>((resolve) => {
    releaseCapture = resolve;
  });
  await page.route(
    `**/api/projects/${project.id}/thumbnail/**`,
    async (route) => {
      await capture;
      await route.continue();
    },
  );

  await page.goto(`/#project/${project.id}`);
  const send = page.getByRole("button", { name: "Send now" });
  await expect(send).toHaveCount(0);
  await expect(page.getByText(reply.text.split("\n")[0])).toBeVisible();
  await page.getByRole("button", { name: /^Draw/ }).click();
  const picture = await page.locator(".edit-picture").boundingBox();
  if (!picture) throw new Error("The picture has no box.");
  await page.mouse.move(
    picture.x + picture.width * 0.4,
    picture.y + picture.height * 0.4,
  );
  await page.mouse.down();
  await page.mouse.move(
    picture.x + picture.width * 0.6,
    picture.y + picture.height * 0.6,
    { steps: 8 },
  );
  await page.mouse.up();
  const note = page.getByLabel("What should change?");
  await note.fill("Lift the headline");
  await note.press("Enter");

  const row = page.getByTitle("Sent with your next message");
  await expect(row).toContainText("1 note");
  const thumb = row.getByRole("button", {
    name: "Open review note Lift the headline",
  });
  await expect(thumb.locator("img")).toHaveCount(0);
  await thumb.click();
  await expect(
    page.getByText("Lift the headline", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Use 1 note in chat" }).click();
  const composer = page.getByLabel("Message your agent");
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Send message" }),
  ).toBeDisabled();

  const outgoing = page.waitForRequest(
    (sent) => sent.method() === "POST" && sent.url().endsWith("/turns"),
  );
  await send.click();
  await expect(send).toBeDisabled();
  releaseCapture();
  const body = (await outgoing).postDataJSON();
  const [saved] = NotebookSchema.parse(
    await (await request.get(`${base}/notebook`)).json(),
  ).items;
  expect(saved?.framePath).toMatch(/\.png$/);
  expect(body).toMatchObject({
    text: "Work through my review notes.",
    attachments: [{ path: saved?.framePath }],
  });
  await expect(row).toHaveCount(0);
});

test("Send now queues the current draft in a busy linked chat", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Busy review chat" },
      })
    ).json(),
  );
  const { ask, session } = agentTurn(project.id);
  const chat = {
    ...session([ask], "running"),
    t3Thread: {
      threadId: "synthetic-thread",
      link: "https://example.com/thread",
    },
  };
  await playSession(page, [chat]);
  // T3 runs in its own environment, even when the local agent is unavailable.
  await page.route("**/api/cutroom/agents/capabilities?**", (route) =>
    route.fulfill({
      json: {
        provider: chat.provider,
        available: false,
        skills: [],
        models: [],
      },
    }),
  );
  await page.route(`**/agents/sessions/${chat.id}/follow-ups`, (route) =>
    route.fulfill({ status: 202, json: { ...chat, queued: true } }),
  );

  await page.setViewportSize({ width: 1000, height: 1050 });
  await page.goto(`/#project/${project.id}`);
  await expect(page.getByText(ask.text, { exact: true })).toBeVisible();
  const base = `/api/cutroom/projects/${project.id}`;
  for (let index = 1; index <= 5; index++) {
    const added = await request.post(`${base}/annotations`, {
      data: {
        time: index,
        body: `Check frame ${index}`,
        kind: "comment",
        compositionPath: "index.html",
      },
    });
    expect(added.ok()).toBe(true);
  }
  const row = page.getByTitle("Sent with your next message");
  await expect(row).toContainText("5 notes");
  await expect(
    row.getByRole("button", { name: /^Open review note/ }),
  ).toHaveCount(3);
  await expect(row.getByText("+2", { exact: true })).toBeVisible();
  expect(
    await row.evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);

  const composer = page.getByLabel("Message your agent");
  const draft = "Check these first.";
  await composer.fill(draft);
  await expect(
    page.getByRole("button", { name: "Queue follow-up" }),
  ).toBeEnabled();
  const outgoing = page.waitForRequest(
    (sent) => sent.method() === "POST" && sent.url().endsWith("/follow-ups"),
  );
  await row.getByRole("button", { name: "Send now" }).click();
  expect((await outgoing).postDataJSON()).toMatchObject({ text: draft });
  await expect(composer).toHaveValue("");
  await expect(row).toContainText("5 notes");
});
