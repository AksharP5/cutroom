export const childComposition =
  '<template><main id="child" data-composition-id="child" data-width="1280" data-height="720" data-duration="20"><div id="cta" style="position:absolute;top:550px;left:100px" data-start="4" data-duration="12">Nested reused ID</div></main></template>';
export function r3Composition(
  kind: "nested" | "inline" | "quirks" | "precision" | "plain",
) {
  const doctype = kind === "quirks" ? "" : "<!doctype html>";
  const other = kind === "quirks" ? "CTA" : "shot-b";
  const host =
    kind === "nested"
      ? '<div id="host" data-composition-id="child" data-composition-src="child.html" data-start="0" data-duration="20" data-track-index="2"></div>'
      : kind === "inline"
        ? '<div id="host" data-composition-id="child" data-start="0" data-duration="20" data-track-index="2"><div id="inner" data-start="4" data-duration="12">Inline child</div></div>'
        : "";
  const at = kind === "precision" ? "1e16" : "4";
  return `${doctype}<html><head><style>html,body{margin:0;background:#111;color:white;font:70px system-ui}.clip{position:absolute;left:100px}</style><script src="gsap.min.js"></script></head><body><main id="main" data-composition-id="main" data-width="1280" data-height="720" data-fps="30" data-duration="20"><div id="cta" class="clip" style="top:150px" data-start="4" data-duration="12" data-track-index="0">Moved title!</div><div id="${other}" class="clip" style="top:400px" data-start="4" data-duration="12" data-track-index="1">Unmoved title</div>${host}</main><script>const tl=gsap.timeline({paused:true});tl.fromTo("#cta",{opacity:0},{opacity:1,duration:2,ease:"none"},${at});window.__timelines.main=tl;</script></body></html>`;
}
