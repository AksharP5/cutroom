import {
  AUTOMATION_EASES,
  automationEaseProgress,
} from "@hyperframes/core/audio-automation";

/**
 * Keep the pinned browser integrator's original grid when a clip starts inside a rate lane, and
 * read a point's named ease with the same function the core patch adds.
 */
export function rampRuntime(source: string): string {
  const offset = (lane: string) =>
    `...(${lane}.target===yl&&${lane}.offset?{offset:${lane}.offset}:{})`;
  const changes = [
    [
      "Zb.get(e);return t||(t=Ik(e),Zb.set(e,t))",
      "Zb.get(e.points);return t||(t=Ik(e),Zb.set(e.points,t))",
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
    [
      "function _k(e){let t=wk(e?.curve),n=zb(e?.viaX,e?.viaY);return{",
      `function _k(e){let t=wk(e?.curve),n=zb(e?.viaX,e?.viaY);return{...${JSON.stringify(AUTOMATION_EASES)}.includes(e?.ease)?{ease:e.ease}:{},`,
    ],
    [
      "function Fk(e,t){",
      `${automationEaseProgress.toString()}function Fk(e,t){if(t.ease)return automationEaseProgress(e,t.ease);`,
    ],
    [
      "for(let f=1;f<=Qb;f+=1)a(Math.max(c,0)+(d-c)*f/Qb)",
      'for(let f=1;f<=Qb;f+=1){let u=Math.max(c,0)+(d-c)*f/Qb;f===Qb&&t[s-1].ease==="hold"&&a(u-1e-9);a(u)}',
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
