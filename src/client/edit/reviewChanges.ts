import { useEffect, useState } from "react";
import { z } from "zod";
import {
  InspectorChangeSchema,
  ReviewChangesSchema,
} from "../../shared/timeline/reviewChanges";
import { api } from "../api";
import { useTimeline } from "./timeline";

const InspectorChangesSchema = z.object({
  rows: z.array(InspectorChangeSchema),
});

function useDetails<T>(
  projectId: string,
  visible: boolean,
  input: string,
  schema: z.ZodType<T>,
) {
  const composition = useTimeline((state) => state.composition);
  // Optimistic timeline updates retain this reference. A settled refresh replaces it,
  // even if only review status changed.
  const entries = useTimeline((state) => state.view?.reviewEntries);
  const failure = useTimeline((state) => state.failedRead);
  const owner = useTimeline((state) => state.projectId);
  const [answer, setAnswer] = useState<{ key: string; value: T }>();
  const key = JSON.stringify([projectId, composition, input]);

  useEffect(() => {
    if (!visible || owner !== projectId || (!entries && !failure)) return;
    const controller = new AbortController();
    void api(
      `/projects/${encodeURIComponent(projectId)}/timeline/changes?composition=${encodeURIComponent(composition)}`,
      schema,
      {
        method: "POST",
        body: input,
        signal: controller.signal,
      },
    )
      .then((value) => {
        if (!controller.signal.aborted) setAnswer({ key, value });
      })
      .catch(() => {
        if (!controller.signal.aborted) setAnswer(undefined);
      });
    return () => controller.abort();
  }, [
    projectId,
    owner,
    visible,
    input,
    composition,
    entries,
    failure,
    schema,
    key,
  ]);

  return visible && answer?.key === key ? answer.value : undefined;
}

export function useInspectorChanges(
  projectId: string,
  visible: boolean,
  clipIds: readonly string[] | undefined,
) {
  const failed = useTimeline((state) => state.failedRead !== null);
  return useDetails(
    projectId,
    visible && !failed,
    JSON.stringify({ view: "inspector", clipIds }),
    InspectorChangesSchema,
  )?.rows;
}

export function useProjectReviewChanges(projectId: string, visible: boolean) {
  const failed = useTimeline((state) => state.failedRead !== null);
  return useDetails(
    projectId,
    visible,
    JSON.stringify({ view: "review", includeClips: failed }),
    ReviewChangesSchema,
  );
}
