import { z } from "zod";
import { EDIT_HISTORY_HEADER } from "../shared/timeline/schema";

/** Fresh for each page, including a duplicated tab; never stored with project data. */
export const tabOrigin = crypto.randomUUID();

/** App, timeline and preview share one project connection per tab. */
const projectStreams = new Map<
  string,
  { source: EventSource; listeners: number }
>();

export function subscribeProjectEvents(
  projectId: string,
  type:
    | "message"
    | "file-change"
    | "export"
    | "ready"
    | "view"
    | "variables"
    | "matte"
    | "animation-left-behind",
  listener: (event: MessageEvent<string>) => void,
) {
  let stream = projectStreams.get(projectId);
  if (!stream) {
    stream = {
      source: new EventSource(
        `/api/cutroom/projects/${encodeURIComponent(projectId)}/events?origin=${tabOrigin}`,
      ),
      listeners: 0,
    };
    projectStreams.set(projectId, stream);
  }
  const shared = stream;
  shared.listeners++;
  shared.source.addEventListener(type, listener);
  return () => {
    shared.source.removeEventListener(type, listener);
    if (--shared.listeners) return;
    shared.source.close();
    projectStreams.delete(projectId);
  };
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** The error's code when the server sends one, such as a timeline refusal's. */
    public readonly code?: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let committedEntry: ((projectId: string, entryId: string) => void) | undefined;

/** Hears each history entry this tab's writes commit, before the history list is read again. */
export function onCommittedEntry(
  listener: (projectId: string, entryId: string) => void,
) {
  committedEntry = listener;
}

/** For a successful write sent without `api`: `path` is the part after /api/cutroom. */
export function reportCommittedEntry(path: string, headers: Headers) {
  const entryId = headers.get(EDIT_HISTORY_HEADER);
  const projectId = /^\/projects\/([^/?]+)/.exec(path)?.[1];
  if (entryId && projectId)
    committedEntry?.(decodeURIComponent(projectId), entryId);
}

export async function api<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
  onHeaders?: (headers: Headers) => void,
): Promise<T> {
  const response = await fetch(`/api/cutroom${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const value: unknown = await response.json().catch((error: unknown) => {
    if (response.ok) throw error;
    return null;
  });
  if (!response.ok) {
    const error = z
      .object({ error: z.string(), code: z.string().optional() })
      .safeParse(value);
    throw new ApiError(
      response.status,
      error.success ? error.data.error : `Request failed (${response.status})`,
      error.success ? error.data.code : undefined,
      value,
    );
  }
  const data = schema.parse(value);
  reportCommittedEntry(path, response.headers);
  onHeaders?.(response.headers);
  return data;
}

export function json(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  body?: unknown,
): RequestInit {
  return {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

/** A project file as the browser loads it; `version` changes when the file is replaced. */
export const mediaUrl = (
  projectId: string,
  path: string,
  version?: string | null,
) =>
  `/api/projects/${encodeURIComponent(projectId)}/preview/${path.split("/").map(encodeURIComponent).join("/")}${version ? `?v=${encodeURIComponent(version)}` : ""}`;

/** `HH:MM:SS:FF` at the composition's nominal frame rate. */
export function frameTimecode(seconds: number, fps: number): string {
  const rate = Math.round(fps);
  const frames = Math.floor(Math.max(0, seconds) * fps + 1e-6);
  return [
    Math.floor(frames / rate / 3600),
    Math.floor(frames / rate / 60) % 60,
    Math.floor(frames / rate) % 60,
    frames % rate,
  ]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

export function timecode(seconds: number): string {
  const value = Math.max(0, seconds);
  const minutes = Math.floor(value / 60);
  return `${String(minutes).padStart(2, "0")}:${String(Math.floor(value % 60)).padStart(2, "0")}.${String(Math.floor((value % 1) * 100)).padStart(2, "0")}`;
}
