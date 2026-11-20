import { useEffect, useEffectEvent, useState } from "react";
import { z } from "zod";
import {
  InspectorChangeSchema,
  ReviewChangesSchema,
} from "../../shared/timeline/reviewChanges";
import { api } from "../api";
import { useTimeline } from "./timeline";

const InspectorChangesSchema = z
  .object({ rows: z.array(InspectorChangeSchema) })
  .transform(({ rows }) => (rows.length ? rows : undefined));

const ProjectReviewChangesSchema = ReviewChangesSchema.transform((value) =>
  value.hasChanges ? value : undefined,
);

function useDetails<T>(
  projectId: string,
  visible: boolean,
  input: string,
  schema: z.ZodType<T | undefined>,
) {
  const composition = useTimeline((state) => state.composition);
  // Optimistic timeline updates retain this reference. A settled refresh replaces it,
  // even if only review status changed.
  const entries = useTimeline((state) => state.view?.reviewEntries);
  const failure = useTimeline((state) => state.failedRead);
  const owner = useTimeline((state) => state.projectId);
  const [answer, setAnswer] = useState<{ key: string; value: T }>();
  const key = JSON.stringify([projectId, composition, input]);
  const receive = useEffectEvent((requestKey: string, value: T | undefined) => {
    if (value !== undefined) setAnswer({ key: requestKey, value });
    else if (answer?.key === requestKey) setAnswer(undefined);
  });

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
        if (!controller.signal.aborted) receive(key, value);
      })
      .catch(() => {
        if (!controller.signal.aborted) receive(key, undefined);
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
  );
}

export function useProjectReviewChanges(projectId: string, visible: boolean) {
  const failed = useTimeline((state) => state.failedRead !== null);
  return useDetails(
    projectId,
    visible,
    JSON.stringify({ view: "review", includeClips: failed }),
    ProjectReviewChangesSchema,
  );
}
