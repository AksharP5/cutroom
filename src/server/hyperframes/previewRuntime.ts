import { readFileSync } from "node:fs";
import { getHyperframeRuntimeScript } from "@hyperframes/core/runtime-script";
import { z } from "zod";

let script: string | undefined;

/**
 * The pinned runtime, adapted for live preview: it observes group faders but only refreshes their
 * gain after removing automation, and it ramps into a lane's first point from the playhead.
 */
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
  // Live preview seeds a lane at the playhead, then ramps each straight segment to its end. A
  // Web Audio ramp starts at the previous event, so a first point after the playhead was ramped
  // from the playhead rather than held until that point, as export holds it. Hold it there.
  const seed =
    '||o.unshift({kind:"set",time:n.scheduledAt,value:(r??_h)(rn(e,n.elapsed,t))}),o}';
  if (source.split(before).length !== 2 || source.split(seed).length !== 2)
    throw new Error(
      "Cutroom's live audio adapters no longer match HyperFrames 0.9.26. Review the runtime adapter before upgrading.",
    );
  script = source
    // A static group fader has no previous automation targets. Refresh its authored gain too.
    .replace(before, "a&&O.length===0&&QW(a,C)")
    .replace(
      seed,
      '||o.unshift({kind:"set",time:n.scheduledAt,value:(r??_h)(rn(e,n.elapsed,t))}),i?.kind==="ramp"&&e.points[0].t>n.elapsed&&o.splice(1,0,{kind:"ramp",time:n.scheduledAt+(e.points[0].t-n.elapsed)/n.rate,value:(r??_h)(e.points[0].v)}),o}',
    );
  return script;
}
