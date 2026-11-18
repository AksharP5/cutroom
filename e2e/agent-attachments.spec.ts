import { join } from "node:path";
import { z } from "zod";
import { agentTurnSchema } from "../src/shared/agent";
import { AnnotationSchema, ProjectSchema } from "../src/shared/project";
import { agentTurn, playSession } from "./agent-turn";
import { expect, test } from "./fixtures";

test("a sent review frame appears in chat and opens at full size", async ({
  page,
  request,
}) => {
  const project = ProjectSchema.parse(
    await (
      await request.post("/api/cutroom/projects", {
        data: { name: "Review frame in conversation" },
      })
    ).json(),
  );
  const base = `/api/cutroom/projects/${project.id}`;
  const saved = await request.post(`${base}/attachments`, {
    data: {
      image:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2V8AAAAASUVORK5CYII=",
    },
  });
  expect(saved.ok()).toBe(true);
  const { path } = z.object({ path: z.string() }).parse(await saved.json());
  const { id } = AnnotationSchema.parse(
    await (
      await request.post(`${base}/annotations`, {
        data: {
          kind: "comment",
          time: 1,
          body: "Lift title",
          compositionPath: "index.html",
        },
      })
    ).json(),
  );
  expect(
    (
      await request.put(`${base}/review/${id}/frame`, {
        data: { framePath: path },
      })
    ).ok(),
  ).toBe(true);

  const { ask, session } = agentTurn(project.id);
  const chat = session([], "idle");
  const missingFrame = { path: join(project.path, "missing-frame.png") };
  const textFile = { path: join(project.path, "index.html") };
  const sentChat = session(
    [{ ...ask, attachments: [missingFrame, textFile] }],
    "idle",
  );
  const timeline = await playSession(page, [chat, sentChat]);
  await page.route(`**/agents/sessions/${chat.id}/turns`, async (route) => {
    const sent = agentTurnSchema.parse(route.request().postDataJSON());
    sentChat.messages = [
      {
        ...ask,
        text: sent.text,
        attachments: [...sent.attachments, missingFrame, textFile],
      },
    ];
    await route.fulfill({ status: 202, json: sentChat });
    await timeline.advance();
  });

  await page.goto(`/#project/${project.id}`);
  await page.getByRole("button", { name: "Send now" }).click();
  const message = page.locator(".message-user");
  await expect(message).toContainText("Work through my review notes.");
  const filename = path.split("/").at(-1) ?? path;
  const opener = message.getByRole("button", { name: filename });
  const thumbnail = opener.getByRole("img");
  await expect(thumbnail).toHaveAttribute("loading", "lazy");
  await expect
    .poll(() => thumbnail.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(1);
  await expect(
    message.getByText("missing-frame.png", { exact: true }),
  ).toBeVisible();
  await expect(message.getByText("index.html", { exact: true })).toBeVisible();
  await opener.click();
  const dialog = page.getByRole("dialog", { name: filename });
  await expect(dialog.getByRole("img", { name: filename })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});
