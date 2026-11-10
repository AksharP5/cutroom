import { z } from "zod";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`/api/cutroom${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const value: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(value);
    throw new ApiError(
      response.status,
      error.success ? error.data.error : `Request failed (${response.status})`,
    );
  }
  return schema.parse(value);
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
