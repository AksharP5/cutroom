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
  ] as const;
  for (const [before] of gradeChanges)
    if (source.split(before).length !== 2)
      throw new Error(
        "Cutroom's colour preview adapter no longer matches HyperFrames 0.9.26.",
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
  for (const [before, after] of [...gradeChanges, ...auditionChanges])
    script = script.replace(before, after);
  return script;
}
