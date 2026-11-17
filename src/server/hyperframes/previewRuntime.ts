import { readFileSync } from "node:fs";
import { getHyperframeRuntimeScript } from "@hyperframes/core/runtime-script";
import { z } from "zod";

let script: string | undefined;

/**
 * The pinned runtime, adapted for live preview: it observes group faders but only refreshes their
 * gain after removing automation, it ramps into a lane's first point from the playhead, and while
 * playing it switches native video visibility for when its picture reaches the screen.
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
  const visibility =
    'let ae=l(G);if(zg.has(G)||(zg.add(G),G.style.visibility==="hidden"&&nd.add(G)),!ae&&!(ie&&Kg(G))){let at=G.style,Je=at.getPropertyPriority("visibility")==="important";!ie&&!Je&&!nd.has(G)&&jg.set(G,at.getPropertyValue("visibility"));let Be=ie?Je&&jg.get(G)||"visible":"hidden";at.setProperty("visibility",Be,ie?"":"important")}';
  const loop = "for(let G of p){if(!Wr(G))continue;";
  const skip = '!G.hasAttribute("data-start")||q?.(G)';
  const display = "ie?_g(G):lM(G)";
  const hidden = "G.toggleAttribute(Qe,!ae&&!ie)";
  // Live preview seeds a lane at the playhead, then ramps each straight segment to its end. A
  // Web Audio ramp starts at the previous event, so a first point after the playhead was ramped
  // from the playhead rather than held until that point, as export holds it. Hold it there.
  const seed =
    '||o.unshift({kind:"set",time:n.scheduledAt,value:(r??_h)(rn(e,n.elapsed,t))}),o}';
  if (
    [before, seed, visibility, loop, skip, display, hidden].some(
      (text) => source.split(text).length !== 2,
    )
  )
    throw new Error(
      "Cutroom's runtime adapters no longer match HyperFrames 0.9.26. Review them before upgrading.",
    );
  script = source
    // A static group fader has no previous automation targets. Refresh its authored gain too.
    .replace(before, "a&&O.length===0&&QW(a,C)")
    // Only the native video's own visibility uses its presented-picture time. The transport
    // still owns media preparation, parent visibility, graphics, and scene teardown.
    .replace(
      loop,
      "let cutTimes=e.isPlaying?window.__cutroomCutTimes?.(u):void 0;" + loop,
    )
    .replace(skip, '!G.hasAttribute("data-start")||!cutTimes?.has(G)&&q?.(G)')
    .replace(
      visibility,
      "let cutTime=cutTimes?.get(G),cutVisible=cutTime===void 0||f?.isGraded(G)?ie:D(G,cutTime)&&Kc(G.parentElement,u,D,v)&&!_e;" +
        visibility.replaceAll("ie", "cutVisible"),
    )
    .replace(display, "cutVisible?_g(G):lM(G)")
    .replace(hidden, "G.toggleAttribute(Qe,!ae&&!cutVisible)")
    .replace(
      seed,
      '||o.unshift({kind:"set",time:n.scheduledAt,value:(r??_h)(rn(e,n.elapsed,t))}),i?.kind==="ramp"&&e.points[0].t>n.elapsed&&o.splice(1,0,{kind:"ramp",time:n.scheduledAt+(e.points[0].t-n.elapsed)/n.rate,value:(r??_h)(e.points[0].v)}),o}',
    );
  return script;
}
