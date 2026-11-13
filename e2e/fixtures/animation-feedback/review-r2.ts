const begin = "const tl=gsap.timeline({paused:true});";
const end = "window.__timelines.main=tl;";
const tween = 'tl.to("#cta",{opacity:1,duration:1},36);';

export const reviewR2Cases = {
  external: {
    script: begin + tween + end,
    extra: '<script src="follow.js"></script>',
    external: 'tl.to("#shot-b",{opacity:1,duration:1,ease:"none"},"<");',
  },
  negativeDelay: {
    script:
      begin +
      'tl.to("#shot-b",{opacity:1,duration:1},5);tl.to("#cta",{opacity:1,duration:1,delay:-36},35);' +
      end,
  },
  aliasedDefaults: {
    script:
      'const defaults=gsap.defaults;defaults({delay:+document.getElementById("cta").dataset.start-36});' +
      begin +
      tween +
      end,
  },
  computedMethod: {
    script:
      'const method="defaults";gsap[method]({delay:+document.getElementById("cta").dataset.start-36});' +
      begin +
      tween +
      end,
  },
  duplicateId: { script: begin + tween + end, duplicate: true },
  membership: {
    script:
      'document.getElementById("shot-b").classList.add("cta");' +
      begin +
      'tl.to(".cta",{opacity:1,duration:1},36);' +
      end,
  },
};
