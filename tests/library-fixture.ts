/**
 * A small HyperFrames registry served through an injected fetch, so library tests never reach
 * the network. Each file is what the real registry serves, cut down.
 */
export const REF = "v0.9.26";
const BASE = `https://raw.githubusercontent.com/heygen-com/hyperframes/${REF}/registry/`;
const CDN = "https://static.heygen.ai/hyperframes-oss/";

export const blockHtml = `<!doctype html>
<html><head><meta charset="UTF-8" /><script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script></head>
<body><div id="root" data-composition-id="lt-clean-bar" data-start="0" data-duration="4" data-width="1920" data-height="1080"
data-composition-variables='[{"id":"name","type":"string","label":"Name","default":"Name Surname"}]'>
<div class="bar"><img src="../assets/lt/bar.png" /><span data-var-text="name">Name Surname</span></div>
<script>window.__timelines = window.__timelines || {}; window.__timelines["lt-clean-bar"] = gsap.timeline({ paused: true });</script>
</div></body></html>
`;

export const fragmentHtml = `<!--
  Blur In.
-->
<div data-hf-ui-root class="hf-ui-blur-in"><span>Design</span> <span>systems</span></div>
<style>.hf-ui-blur-in span { display: inline-block; }</style>
<script>(function () { var vars = window.__hyperframes ? window.__hyperframes.getVariables() : {}; })();</script>
<!--
  Timeline integration:
  tl.fromTo('.hf-ui-blur-in span', { opacity: 0 }, { opacity: 1, duration: 0.36, stagger: 0.04 }, startTime);
-->
`;

const grainHtml = `<!doctype html><html><body><div id="root" data-composition-id="grain" data-duration="4" data-width="1920" data-height="1080"><div class="grain"></div>
<script>window.__timelines = window.__timelines || {}; window.__timelines.grain = { pause() {}, seek() {}, duration: () => 4 };</script></div></body></html>`;

const items: Record<string, unknown> = {
  "blocks/lt-clean-bar": {
    name: "lt-clean-bar",
    type: "hyperframes:block",
    title: "Lower Third — Clean Bar",
    description: "Minimal white-card lower third",
    tags: ["lower-third", "overlay"],
    license: "Apache-2.0",
    author: "HeyGen",
    dimensions: { width: 1920, height: 1080 },
    duration: 4.8,
    variables: [
      { id: "name", type: "string", label: "Name", default: "Name Surname" },
    ],
    files: [
      {
        path: "lt-clean-bar.html",
        target: "compositions/lt-clean-bar.html",
        type: "hyperframes:composition",
      },
      {
        path: "bar.png",
        url: `${CDN}registry/blocks/lt-clean-bar/bar.png`,
        target: "assets/lt/bar.png",
        type: "hyperframes:asset",
      },
      {
        path: "TEMPLATE.md",
        target: "TEMPLATE.md",
        type: "hyperframes:asset",
      },
    ],
    preview: { poster: `${CDN}docs/images/catalog/blocks/lt-clean-bar.png` },
  },
  "components/blur-in": {
    name: "blur-in",
    type: "hyperframes:component",
    title: "Blur In",
    description: "Words resolve out of blur",
    tags: ["text-effect"],
    variables: [
      {
        id: "size",
        type: "number",
        label: "Size",
        default: 52,
        min: 24,
        max: 120,
      },
    ],
    files: [
      {
        path: "blur-in.html",
        target: "compositions/components/blur-in.html",
        type: "hyperframes:snippet",
      },
    ],
  },
  "components/grain": {
    name: "grain",
    type: "hyperframes:component",
    title: "Grain",
    description: "Film grain over the frame",
    tags: ["effect", "grain"],
    files: [
      {
        path: "grain.html",
        target: "compositions/components/grain.html",
        type: "hyperframes:snippet",
      },
    ],
  },
  "blocks/old-title": {
    name: "old-title",
    type: "hyperframes:block",
    title: "Old Title",
    description: "Replaced",
    tags: ["title-card"],
    deprecated: "Use title-card instead",
    dimensions: { width: 1920, height: 1080 },
    duration: 3,
    files: [
      {
        path: "a.html",
        target: "compositions/a.html",
        type: "hyperframes:composition",
      },
    ],
  },
  "blocks/future-chart": {
    name: "future-chart",
    type: "hyperframes:block",
    title: "Future Chart",
    description: "Needs a newer runtime",
    tags: ["chart"],
    minCliVersion: "0.10.0",
    dimensions: { width: 1920, height: 1080 },
    duration: 3,
    files: [
      {
        path: "c.html",
        target: "compositions/c.html",
        type: "hyperframes:composition",
      },
    ],
  },
  "blocks/escape": {
    name: "escape",
    type: "hyperframes:block",
    title: "Escape",
    description: "Writes outside the project",
    tags: [],
    dimensions: { width: 1920, height: 1080 },
    duration: 3,
    files: [
      {
        path: "e.html",
        target: "../outside.html",
        type: "hyperframes:composition",
      },
    ],
  },
  "blocks/elsewhere": {
    name: "elsewhere",
    type: "hyperframes:block",
    title: "Elsewhere",
    description: "Fetches from a host the library does not trust",
    tags: [],
    dimensions: { width: 1920, height: 1080 },
    duration: 3,
    files: [
      {
        path: "x.html",
        url: "https://example.com/x.html",
        target: "compositions/elsewhere.html",
        type: "hyperframes:composition",
      },
    ],
  },
};

const files: Record<string, string> = {
  [`${BASE}blocks/lt-clean-bar/lt-clean-bar.html`]: blockHtml,
  [`${CDN}registry/blocks/lt-clean-bar/bar.png`]: "PNG bytes",
  [`${BASE}blocks/lt-clean-bar/TEMPLATE.md`]: "# Template",
  [`${BASE}components/blur-in/blur-in.html`]: fragmentHtml,
  [`${BASE}components/grain/grain.html`]: grainHtml,
  [`${CDN}docs/images/catalog/blocks/lt-clean-bar.png`]: "poster bytes",
  "https://example.com/x.html": "<div></div>",
};

/** The registry, served by URL; `offline` makes every request fail as a dropped network does. */
export function registryFetch() {
  const state = { offline: false, requests: [] as string[] };
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    state.requests.push(url);
    if (state.offline) throw new TypeError("fetch failed");
    if (url === `${BASE}registry.json`)
      return Response.json({
        name: "hyperframes",
        homepage: "https://hyperframes.heygen.com",
        items: [
          ...Object.keys(items).map((key) => {
            const [dir, name] = key.split("/");
            return {
              name,
              type:
                dir === "blocks"
                  ? "hyperframes:block"
                  : "hyperframes:component",
            };
          }),
          { name: "starter", type: "hyperframes:example" },
        ],
      });
    const item =
      /registry\/(blocks|components)\/([^/]+)\/registry-item\.json$/.exec(url);
    if (item && url.startsWith(BASE)) {
      const value = items[`${item[1]}/${item[2]}`];
      return value ? Response.json(value) : new Response("", { status: 404 });
    }
    const body = files[url];
    return body === undefined
      ? new Response("", { status: 404 })
      : new Response(body);
  }) as typeof fetch;
  return { fetchImpl, state };
}
