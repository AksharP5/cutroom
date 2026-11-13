/** Scripts from the rewrite reviews. Edits now leave every script intact and warn. */
export const reviewTweenScripts = {
  relative: `const tl=gsap.timeline({paused:true});tl.fromTo('#cta',{opacity:0},{opacity:1,duration:1,ease:'none'},36);tl.fromTo('#shot-b',{opacity:0},{opacity:1,duration:1,ease:'none'},'<');window.__timelines.main=tl;`,
  mutablePosition: `const tl=gsap.timeline({paused:true});let at=36;at=40;tl.to('#cta',{x:100,duration:1},at);window.__timelines.main=tl;`,
  mutableTarget: `const tl=gsap.timeline({paused:true});let target=document.getElementById('cta');target=document.getElementById('shot-b');tl.to(target,{x:100,duration:1},36);window.__timelines.main=tl;`,
  nestedScaled: `const child=gsap.timeline();child.to('#cta',{x:100,duration:1},2);child.timeScale(2);const tl=gsap.timeline({paused:true});tl.add(child,35);window.__timelines.main=tl;`,
  helperMap: `const tl=gsap.timeline({paused:true});function other(tl){tl.to('#cta',{opacity:1,duration:1},36);}other({to(){}});tl.to('#cta',{opacity:1,duration:1},36);window.__timelines.main=tl;`,
  wrongTimeline: `const other=gsap.timeline({paused:true});other.to('#cta',{x:100,duration:1},36);const tl=gsap.timeline({paused:true});tl.to('#cta',{opacity:1,duration:1},36);window.__timelines.main=tl;`,
};
