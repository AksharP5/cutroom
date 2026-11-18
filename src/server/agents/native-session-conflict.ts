import { HttpError } from "../../shared/errors";

export class NativeSessionConflict extends HttpError {
  readonly code = "native_session_conflict";

  constructor(provider: "claude" | "codex") {
    super(
      409,
      provider === "codex"
        ? "This chat is open in another app. Close it there, or branch it."
        : "This chat changed in another app less than two minutes ago. Wait, or branch it.",
    );
  }
}

export function guardClaudeSession(
  lastModified: number,
  lastOwnWrite: number | undefined,
  now = Date.now(),
) {
  if (lastModified > (lastOwnWrite ?? 0) && now - lastModified < 120_000)
    throw new NativeSessionConflict("claude");
}
