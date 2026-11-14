import { readFileSync } from "node:fs";
import { getHyperframeRuntimeScript } from "@hyperframes/core/runtime-script";
import { z } from "zod";

let script: string | undefined;

/** The pinned runtime observes group faders, but only refreshes their gain after removing automation. */
export function previewRuntimeScript() {
  if (script !== undefined) return script;
  z.object({ version: z.literal("0.9.26") }).parse(
    JSON.parse(
      readFileSync(
        new URL("../package.json", import.meta.resolve("@hyperframes/core")),
        "utf8",
      ),
    ),
  );
  const source = getHyperframeRuntimeScript();
  const before = "a&&O.length===0&&c.some($=>$.param===a.param)&&QW(a,C)";
  if (source.split(before).length !== 2)
    throw new Error(
      "Cutroom's live group faders no longer match HyperFrames 0.9.26. Review the runtime adapter before upgrading.",
    );
  // A static group fader has no previous automation targets. Refresh its authored gain too.
  script = source.replace(before, "a&&O.length===0&&QW(a,C)");
  return script;
}
