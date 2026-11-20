import { readFileSync } from "node:fs";
import { getHyperframeRuntimeScript } from "@hyperframes/core/runtime-script";
import { z } from "zod";
import { rampRuntime } from "./rampRuntime";

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
  const source = rampRuntime(getHyperframeRuntimeScript());
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
  const mountDefaults =
    "let o={...e.declaredVariableDefaults??(We(t)?ma(t):{}),...IS(e.host)};";
  const fetchedTemplate =
    '(s?A.querySelector(`template#${CSS.escape(s)}-template`):null)??A.querySelector("template")';
  if (
    source.split(mountDefaults).length !== 2 ||
    source.split(fetchedTemplate).length !== 2
  )
    throw new Error(
      "Cutroom's scene variable adapter no longer matches HyperFrames 0.9.26. Review the runtime adapter before upgrading.",
    );
  const gradeChanges = [
    // Video frame callbacks already redraw while playing. timeupdate would upload and shade
    // the same picture again, including the copy back from WebGL to the clip canvas.
    [
      'gr(e,e.element,"timeupdate",t),gr(e,window,"resize",t)',
      'gr(e,e.element,"timeupdate",()=>{(!ve(e.element)||e.element.paused||typeof e.element.requestVideoFrameCallback!=="function")&&t()}),gr(e,window,"resize",t)',
    ],
    // Parked videos retain their attributes for seek, edit and fallback. The runtime must
    // neither draw them nor keep a pending grading entry for each of them.
    [
      "function Bp(e){return cH(e)||GH(e)}",
      "function Bp(e){return !window.__cutroomParkedMedia?.has(e)&&(cH(e)||GH(e))}",
    ],
    [
      "if(!br(L))return;F.add(L);let V=Ka(L)",
      "if(!br(L)||window.__cutroomParkedMedia?.has(L))return;F.add(L);let V=Ka(L)",
    ],
    [
      "E=(F,N,L)=>{r.delete(F);let V=t.get(F);",
      "E=(F,N,L)=>{r.delete(F);if(window.__cutroomParkedMedia?.has(F))return!1;let V=t.get(F);",
    ],
    [
      '(!L.isConnected||V.source==="attribute"&&!F.has(L))',
      '(!L.isConnected||window.__cutroomParkedMedia?.has(L)||V.source==="attribute"&&!F.has(L))',
    ],
  ] as const;
  for (const [before] of gradeChanges)
    if (source.split(before).length !== 2)
      throw new Error(
        "Cutroom's colour preview adapter no longer matches HyperFrames 0.9.26.",
      );
  script = source
    // A standalone preview fetches its children. Use the same template and default order as the compiler.
    .replace(fetchedTemplate, 'A.querySelector("template")')
    .replace(
      mountDefaults,
      "let o={...e.declaredVariableDefaults,...(We(t)?ma(t):{}),...IS(e.host)};",
    )
    // A static group fader has no previous automation targets. Refresh its authored gain too.
    .replace(before, "a&&O.length===0&&QW(a,C)")
    .replace(
      seed,
      '||o.unshift({kind:"set",time:n.scheduledAt,value:(r??_h)(rn(e,n.elapsed,t))}),i?.kind==="ramp"&&e.points[0].t>n.elapsed&&o.splice(1,0,{kind:"ramp",time:n.scheduledAt+(e.points[0].t-n.elapsed)/n.rate,value:(r??_h)(e.points[0].v)}),o}',
    );
  for (const [before, after] of gradeChanges)
    script = script.replace(before, after);
  return script;
}
