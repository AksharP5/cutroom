import { useEffect, useState } from "react";
import { MediaInfoSchema } from "../shared/media";
import type { MediaInfo } from "../shared/media";
import { readPictureSource } from "../shared/timeline/pictureSource";

export function mediaAssetUrl(
  projectId: string,
  kind: string,
  path: string,
  version?: string | null,
) {
  const query = new URLSearchParams({ path });
  if (version) query.set("v", version);
  return `/api/cutroom/projects/${encodeURIComponent(projectId)}/media/${kind}?${query}`;
}

/** Media jobs answer 202 until the requested asset is ready to read. */
export async function fetchMediaReady(
  url: string,
  signal: AbortSignal,
  pollMs: number,
  method: "GET" | "HEAD" = "GET",
) {
  for (;;) {
    const response = await fetch(url, { signal, method });
    if (response.status !== 202) return response.ok ? response : null;
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    signal.throwIfAborted();
  }
}

export async function fetchMediaProbe(url: string, signal: AbortSignal) {
  const response = await fetchMediaReady(url, signal, 200);
  return response ? MediaInfoSchema.parse(await response.json()) : null;
}

/** An unavailable index leaves the video on its own presentation clock. */
export async function fetchPictureSource(url: string, signal: AbortSignal) {
  return fetch(url, { signal })
    .then(async (response) =>
      response.ok ? readPictureSource(await response.json()) : null,
    )
    .catch(() => null);
}

/** Undefined while loading, null if the file could not be probed. */
export function useMediaProbe(url: string | null) {
  const [probe, setProbe] = useState<{ url: string; info: MediaInfo | null }>();
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    const { signal } = controller;
    void fetchMediaProbe(url, signal)
      .catch((error: unknown) => {
        if (!signal.aborted) console.warn("Media probe failed", error);
        return null;
      })
      .then((info) => {
        if (!signal.aborted) setProbe({ url, info });
      });
    return () => controller.abort();
  }, [url]);
  return probe?.url === url ? probe.info : undefined;
}
