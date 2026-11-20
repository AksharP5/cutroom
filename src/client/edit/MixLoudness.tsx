import { useEffect, useState } from "react";
import { z } from "zod";
import { mixLoudnessFx } from "../../shared/timeline/fx";
import { editTimeline } from "./timeline";

/** The loudness most streaming platforms and podcasts deliver at. */
const TARGET_LUFS = -16;

const LoudnessSchema = z.object({
  lufs: z.number().nullable(),
  truePeak: z.number().nullable(),
});

/**
 * A finished whole-timeline export's loudness, and a gain on the mix's master bus that brings
 * the next export to the target. The gain is one undo step and processes nothing else.
 */
export function MixLoudness({
  projectId,
  jobId,
}: {
  projectId: string;
  jobId: string;
}) {
  const [measured, setMeasured] = useState<z.infer<
    typeof LoudnessSchema
  > | null>(null);
  const [set, setSet] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/render/${encodeURIComponent(jobId)}/loudness`, {
      signal: controller.signal,
    })
      .then(async (response) =>
        // A range export or a missing FFmpeg has no mix to measure; the row stays away.
        response.ok ? LoudnessSchema.parse(await response.json()) : null,
      )
      .then(setMeasured)
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [jobId]);
  if (error)
    return <p className="export-error">Could not measure the mix: {error}</p>;
  if (measured?.lufs === null || !measured) return null;
  const { lufs, truePeak } = measured;
  return (
    <>
      <dl className="export-summary">
        <dt>Loudness</dt>
        <dd className="mono">
          {`${lufs.toFixed(1)} LUFS`}
          {truePeak !== null && `, peaks ${truePeak.toFixed(1)} dBTP`}
        </dd>
      </dl>
      {set ? (
        <p className="export-hint">
          The mix is set to reach {TARGET_LUFS} LUFS. Export again to hear it.
        </p>
      ) : (
        Math.abs(lufs - TARGET_LUFS) >= 0.5 && (
          <button
            className="secondary-button"
            onClick={() =>
              void editTimeline(
                projectId,
                `Normalize mix to ${TARGET_LUFS} LUFS`,
                (timeline) => [
                  {
                    type: "setMaster",
                    fx: mixLoudnessFx(
                      timeline.main?.fx ?? [],
                      lufs,
                      TARGET_LUFS,
                    ),
                  },
                ],
              ).then((applied) => setSet(applied))
            }
          >
            Normalize mix to {TARGET_LUFS} LUFS
          </button>
        )
      )}
    </>
  );
}
