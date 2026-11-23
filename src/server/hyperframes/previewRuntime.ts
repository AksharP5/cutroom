import { readFileSync } from "node:fs";
import { getHyperframeRuntimeScript } from "@hyperframes/core/runtime-script";
import { z } from "zod";
import { rampRuntime } from "./rampRuntime";

let script: string | undefined;

/**
 * The pinned runtime, adapted for live preview: it observes group faders but only refreshes their
 * gain after removing automation, and it ramps into a lane's first point from the playhead. The
 * mixer also needs to move a fader before the edit is saved, and to see an automated fader.
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
  const runtimeChanges = [
    // At rest the bridge polls for duration changes. Each element.getAnimations() can
    // flush style across the composition, even when the element is far from the playhead.
    // Take one animation snapshot for both adapters, then look up effects by their target.
    [
      'dt=(u=!1)=>{let p=0;for(let h of e.deterministicAdapters){let b=u?h.getAnimationCycleEndSeconds:h.getInferredDurationSeconds;if(typeof b!="function")continue;let v=null;try{v=b()}',
      'dt=(u=!1)=>{let p=0,animations=a3();for(let h of e.deterministicAdapters){let b=u?h.getAnimationCycleEndSeconds:h.getInferredDurationSeconds;if(typeof b!="function")continue;let v=null;try{v=b(animations)}',
    ],
    [
      "getInferredDurationSeconds:()=>{let m=0;for(let g of t){if(!g.el.isConnected)continue;let x=i(g.el);for(let y of n(g.el)){let E=l(y,x);E.endSeconds!=null&&(m=Math.max(m,E.endSeconds))}}return m>0?m:null}",
      "getInferredDurationSeconds:(pageAnimations)=>{if(!t.length)return null;" +
        "let byTarget=new Map;for(let animation of n(document,pageAnimations)){" +
        "let effect=animation.effect,target=effect?.target;if(!target||effect.pseudoElement)continue;" +
        "let list=byTarget.get(target);if(list)list.push(animation);else byTarget.set(target,[animation])}" +
        "let m=0;for(let g of t){if(!g.el.isConnected)continue;let x=i(g.el);for(let y of byTarget.get(g.el)??[]){let E=l(y,x);E.endSeconds!=null&&(m=Math.max(m,E.endSeconds))}}return m>0?m:null}",
    ],
    [
      "getInferredDurationSeconds:()=>{let A=0;for(let w of s())",
      "getInferredDurationSeconds:(pageAnimations)=>{let A=0;for(let w of s(pageAnimations))",
    ],
    // Studio retains a fully buffered source after its clip leaves the preload window.
    // On a long timeline those sources accumulate even after a jump to a distant clip.
    ["Wy(u,!Yc||window.__HF_RELEASE_PASSED_MEDIA===!0)", "Wy(u,!0)"],
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
    // Draft messages change one clip. Leave the other clips' parsed grades and pending
    // sources intact. Runtime changes and pipeline ownership still refresh the whole set.
    [
      'S=()=>{if(s)return 0;let F=new Set;r.clear(),document.querySelectorAll(Yw).forEach(L=>{if(!br(L))return;F.add(L);let V=Ka(L);Qo(L,V)?Bp(L)?E(L,V,"attribute"):(w(L),r.add(L)):w(L)});',
      `cutroomGradeAttributes=null,S=target=>{
        if(s)return 0;
        let F=new Set;
        const syncGrade=element=>{
          if(!br(element)||window.__cutroomParkedMedia?.has(element))return;
          F.add(element);
          const grade=Ka(element);
          if(!Qo(element,grade)){w(element);return;}
          if(Bp(element)){E(element,grade,"attribute");return;}
          w(element);
          r.add(element);
        };
        if(target){
          (cutroomGradeAttributes??=new WeakMap).set(target,target.getAttribute(No));
          syncGrade(target);
          return n.size;
        }
        r.clear();
        document.querySelectorAll(Yw).forEach(syncGrade);`,
    ],
    // Skip the draft changes the bridge already drew in this observer delivery. A later
    // authored change can restore the same value and must still redraw the clip.
    [
      "i=new MutationObserver(N=>{F(N)&&S()})",
      `i=new MutationObserver(changes=>{
        const drawn=cutroomGradeAttributes;
        cutroomGradeAttributes=null;
        const remaining=drawn?changes.filter(change=>
          change.type!=="attributes"||change.attributeName!==No||
          drawn.get(change.target)!==change.target.getAttribute(No)):changes;
        if(F(remaining))S();
      })`,
    ],
    [
      "E=(F,N,L)=>{r.delete(F);let V=t.get(F);",
      "E=(F,N,L)=>{r.delete(F);if(window.__cutroomParkedMedia?.has(F))return!1;let V=t.get(F);",
    ],
    [
      '(!L.isConnected||V.source==="attribute"&&!F.has(L))',
      '(!L.isConnected||window.__cutroomParkedMedia?.has(L)||V.source==="attribute"&&!F.has(L))',
    ],
    // A clip's window is capped at its source's natural length after the in-point, so a loop
    // stopped at its first wrap. Export plays a loop for its whole data-duration, or until its
    // scene ends; a loop has no natural end.
    [
      "_=Number.isFinite(p.duration)?on(p,p.duration):null",
      "_=!p.loop&&Number.isFinite(p.duration)?on(p,p.duration):null",
    ],
  ] as const;
  for (const [before] of runtimeChanges)
    if (source.split(before).length !== 2)
      throw new Error(
        `Cutroom's media preview adapter no longer matches HyperFrames 0.9.26 near ${before.slice(0, 64)}.`,
      );
  // Gate the takes after their effects and fades so the outgoing take's effect tails fade too.
  const auditionChanges = [
    [
      "var Kh=e=>Br(e)||ve(e)&&kl(e)&&Dy(",
      'var Kh=e=>Br(e)||ve(e)&&kl(e)&&(e.hasAttribute("data-cutroom-version-owner")||Dy(',
    ],
    [
      "masterChain:lx(e.ownerDocument)}),pR=",
      "masterChain:lx(e.ownerDocument)})),pR=",
    ],
    [
      "function s3(e,t){return Ot()&&Br(e)",
      'function s3(e,t){return !e.hasAttribute("data-cutroom-version-owner")&&Ot()&&Br(e)',
    ],
    [
      "f.connect(this.resolveDestination(t,m,o,d)??this._masterGain);let y=this._ctx.createGain();",
      'let cutroomDestination=this.resolveDestination(t,m,o,d)??this._masterGain,cutroomGain;if(t.hasAttribute("data-cutroom-version-owner")&&window.__cutroomAuditionGains){cutroomGain=this._ctx.createGain();cutroomGain.gain.value=Number(t.hasAttribute("data-cutroom-shown"));f.connect(cutroomGain);cutroomGain.connect(cutroomDestination);window.__cutroomAuditionGains.set(t,cutroomGain)}else f.connect(cutroomDestination);let y=this._ctx.createGain();',
    ],
    [
      "unfollow:this.followElement(t,n,r,E,S)",
      "unfollow:(()=>{const follow=this.followElement(t,n,r,E,S);return()=>{follow();if(cutroomGain){cutroomGain.disconnect();window.__cutroomAuditionGains?.delete(t)}}})()",
    ],
  ] as const;
  for (const [before] of auditionChanges)
    if (source.split(before).length !== 2)
      throw new Error(
        "Cutroom's media audition adapter no longer matches HyperFrames 0.9.26.",
      );
  const meter =
    "window.__hf.audioMeter={start:()=>M.startMetering(),stop:()=>M.stopMetering(),read:()=>M.readLevels()}";
  if (source.split(meter).length !== 2)
    throw new Error(
      "Cutroom's mixer adapter no longer matches HyperFrames 0.9.26.",
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
  for (const [before, after] of [...runtimeChanges, ...auditionChanges])
    script = script.replace(before, after);
  // A mixer fader is heard while it moves, before anything is saved: a bus's fader gain, or a
  // trim after the master chain for Main. Automated faders report where their lane holds them.
  script = script.replace(
    meter,
    // `pre` meters clips that play through a bus as they enter it, by their track, so a track
    // whose clips all go to buses still shows what comes from it. Its taps live while metering.
    "window.__hf.audioMeter=(()=>{let T=new Map;function clear(){for(let t of T.values())t.dispose();T.clear()}return{start:()=>M.startMetering(),stop:()=>{M.stopMetering();clear()},clearPre:clear,read:()=>M.readLevels()," +
      "fade:(t,n)=>{let r=t===null?M._busOut:M._groups.get(t)?.fader;r&&M._ctx&&r.gain.setTargetAtTime(n,M._ctx.currentTime,.004)}," +
      "faders:t=>{let n={};for(let r of t){let o=M._groups.get(r);o&&(n[r]=o.fader.gain.value)}return n}," +
      'pre:()=>{let n={};for(let r of M._activeSources){let o=r.el,g=o?.getAttribute?.("data-audio-group"),e=g?o.ownerDocument.getElementById(g):null,k=o?.getAttribute?.("data-track-index");if(!e||e.tagName.toLowerCase()!=="hf-audio-group"||e.hasAttribute("data-cutroom-track")||k==null||!r.gainNode||!M._ctx)continue;let p=T.get(r);p||(p=Ph(M._ctx,r.gainNode),T.set(r,p));let v=p.read(),c=n[k];n[k]=c?{l:Math.max(c.l,v.l),r:Math.max(c.r,v.r)}:v}for(let[r,p]of T)M._activeSources.includes(r)||(p.dispose(),T.delete(r));return n}}})()',
  );
  return script;
}
