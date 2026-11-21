import { createHash, randomUUID } from "node:crypto";
import type { HistoryWho } from "../history/historyLog";
import type { Context } from "hono";
import {
  AGENT_HEADER,
  AGENT_NAME_HEADER,
  AgentNameSchema,
} from "../../shared/review";
import { HttpError } from "../../shared/errors";
import type { Project } from "../../shared/project";
import type { ReviewService } from "./review";

export const ownerWho = {
  kind: "person",
  name: "You",
  key: "owner",
} satisfies HistoryWho;

// One credential per bridge or HTTP MCP session. Only its digest goes into history.
export const externalHistoryCredential = () => `external:${randomUUID()}`;
export const isExternalHistoryCredential = (token: string) =>
  /^external:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    token,
  );

export function historyActor(
  reviews: ReviewService,
  c: Context,
  project: Project,
) {
  const token = c.req.header(AGENT_HEADER);
  if (token === undefined)
    return { who: ownerWho, review: { kind: "human" } as const };
  const actor = reviews.agent(project, token);
  let name = actor.turn.name;
  if (!name) {
    try {
      name = AgentNameSchema.parse(
        decodeURIComponent(c.req.header(AGENT_NAME_HEADER) ?? "Agent"),
      );
    } catch {
      throw new HttpError(400, "Use a valid agent display name.");
    }
  }
  const key =
    actor.turn.kind === "message" || isExternalHistoryCredential(token)
      ? `session:${createHash("sha256").update(token).digest("hex")}`
      : undefined;
  const who: HistoryWho = { kind: "agent", name, ...(key && { key }) };
  return { who, review: actor };
}
