import { rampMediaTimeAt } from "../../shared/timeline/rampWindow.ts";

/** Keep the pinned browser integrator's original grid when a clip starts inside a rate lane. */
export function rampRuntime(source: string): string {
  const offset = (lane: string) =>
    `...(${lane}.target===yl&&${lane}.offset?{offset:${lane}.offset}:{})`;
  const changes = [
    [
      "Zb.get(e);return t||(t=Ik(e),Zb.set(e,t))",
      "Zb.get(e.points);return t||(t=Ik(e),Zb.set(e.points,t))",
    ],
    [
      "function yt(e,t){let n=Math.max(0,Math.min(t,e.end)-(e.origin??e.start)),r=e.mediaStart+tr(e.rate??e.playbackRate,n);",
      `const cutroomRampMediaTimeAt = ${rampMediaTimeAt.toString()};function yt(e,t){let n=Math.max(0,Math.min(t,e.end)-(e.origin??e.start)),r=typeof e.rate==="object"?cutroomRampMediaTimeAt({start:e.origin??e.start,end:e.end,mediaStart:e.mediaStart,rate:e.rate},t,tr):e.mediaStart+tr(e.rate??e.playbackRate,n);`,
    ],
    [
      "return{target:a.target,points:a.points}});return Ck",
      `if(a.target===yl&&a.offset!==void 0&&!Number.isFinite(a.offset))throw new An("Invalid rate offset.");return{target:a.target,points:a.points,${offset("a")}}});return Ck`,
    ],
    [
      "t.push({target:n.target,points:o})",
      `t.push({target:n.target,points:o,${offset("n")}})`,
    ],
    [
      "n.push({target:r.target,points:i})",
      `n.push({target:r.target,points:i,${offset("r")}})`,
    ],
    [
      'function Ui(e,t){return typeof e=="number"?e:tf(e)?rn(e,t,"log"):1}',
      'function Ui(e,t){return typeof e=="number"?e:tf(e)?rn(e,t+(e.offset??0),"log"):1}',
    ],
    [
      "function tr(e,t){",
      "function tr(e,t){const o=e.offset??0;return o?cutroomRateIntegral(e,o+t)-cutroomRateIntegral(e,o):cutroomRateIntegral(e,t)}function cutroomRateIntegral(e,t){",
    ],
    [
      "function _n(e,t){",
      "function _n(e,t){const o=e.offset??0;return o?cutroomRateInverse(e,t+cutroomRateIntegral(e,o))-o:cutroomRateInverse(e,t)}function cutroomRateInverse(e,t){",
    ],
  ] as const;
  for (const [before, after] of changes) {
    if (source.split(before).length !== 2)
      throw new Error(
        "Cutroom's speed ramp adapter no longer matches HyperFrames 0.9.26.",
      );
    source = source.replace(before, after);
  }
  return source;
}
