import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTimelineRoutes } from "../src/server/timeline/routes";
import { TimelineViewSchema } from "../src/shared/timeline/schema";
import { projectFixture } from "./project-fixture";
import { parseComposition } from "../src/server/timeline/composition";
import { unsupportedPositions } from "../src/server/timeline/positionSupport";
import { emptyTimelineSettings } from "../src/shared/timeline/schema";

const support = (script: string) =>
  unsupportedPositions(
    parseComposition(
      `<html><head><script src="gsap.min.js"></script></head><body><main id="main" data-composition-id="main" data-duration="2"><video id="video" data-start="0" data-duration="2"></video><img id="image" data-start="0" data-duration="2"><p id="text" data-start="0" data-duration="2">Text</p><div id="title" data-start="0" data-duration="2">Title</div></main><script>${script}</script></body></html>`,
      emptyTimelineSettings(),
    ),
  );

const forms = [
  (target: string, vars: string) => `gsap.to("${target}",${vars});`,
  (target: string, vars: string) =>
    `const tl=gsap.timeline({paused:true});tl.to("${target}",${vars});window.__timelines.main=tl;`,
  (target: string, vars: string) =>
    `window.__timelines.main=gsap.timeline({paused:true}).to("${target}",${vars}).to("#title",{opacity:1});`,
];
for (const [i, form] of forms.entries()) {
  test(`GSAP form ${i}: CSS translate on a clip refuses Position`, () => {
    expect(
      support(form("#title", '{translate:"100px 20px",duration:1}')).title,
    ).toMatch(/coordinate animations/);
  });
  test(`GSAP form ${i}: ancestor scale refuses, opacity and colour stay supported`, () => {
    const scaled = support(form("#main", "{scale:.5,duration:1}"));
    for (const id of ["video", "image", "text", "title"])
      expect(scaled[id]).toMatch(/transformed container/);
    expect(support(form("#main", "{opacity:.5,duration:1}"))).toEqual({});
    expect(
      support(
        form(
          "#main",
          '{opacity:.5,color:"red",filter:"blur(1px)",clipPath:"inset(0)",duration:1}',
        ),
      ),
    ).toEqual({});
    expect(
      support(form("#title", '{opacity:.5,color:"red",duration:1}')),
    ).toEqual({});
    expect(
      support(form("#main", '{transformOrigin:"0 0",duration:1}')),
    ).toEqual({});
    expect(support("")).toEqual({});
  });
}

test("coordinate properties in from/fromTo/set, nested CSS, keyframes and defaults refuse", () => {
  for (const script of [
    'gsap.from("#title",{x:40})',
    'gsap.fromTo("#title",{left:10},{left:20})',
    'gsap.set("#title",{transform:"translate(20px)"})',
    'gsap.to("#title",{css:{translate:"20px"}})',
    'gsap.to("#title",{keyframes:[{y:10},{y:20}]})',
    'const tl=gsap.timeline({defaults:{x:40}});tl.to("#title",{opacity:1})',
    'gsap.to("#title",{clearProps:"all"})',
    'gsap.to("#title",{attr:{style:"translate:20px"}})',
  ])
    expect(support(script).title).toMatch(/coordinate animations/);
  expect(support('gsap.to("#image",{x:20})').title).toBeUndefined();
});

test("GSAP transform aliases follow the same coordinate refusal rule", () => {
  expect(support('gsap.to("#title",{translateX:40})').title).toMatch(
    /coordinate animations/,
  );
  expect(support('gsap.to("#title",{translateY:40})').title).toMatch(
    /coordinate animations/,
  );
  expect(support('gsap.to("#main",{rotateZ:45})').title).toMatch(
    /transformed container/,
  );
});

test("unknown script syntax never silently enables Position", () => {
  for (const script of [
    "gsap.to(target,{opacity:0})",
    'gsap.to("#title",{["translate"]:"20px"})',
    'gsap.to("#title",{...vars})',
    'gsap.to("#title",{x:()=>20})',
    'gsap["to"]("#title",{opacity:0})',
    'gsap.to("#title",{opacity:0}).to("#main",{scale:.5})',
    'const tl=gsap.timeline();const alias=tl;alias.to("#main",{scale:.5})',
    'gsap.timeline().add(()=>gsap.to("#title",{x:20}))',
    'const tl=gsap.timeline();tl.add(gsap.to("#main",{scale:.5}))',
    `eval("gsap.to('#title',{x:20})")`,
    `new Function("gsap.to('#title',{x:20})")()`,
    'const animate=gsap.to;animate("#title",{x:20})',
    'window["__timelines"].main=gsap.timeline()',
    "not valid javascript",
  ])
    expect(support(script).title).toMatch(/unrecognised/);
});

test("position support refuses source shapes that cannot keep a draft and its committed offset exact", () => {
  const support = (body: string, head = "") =>
    unsupportedPositions(
      parseComposition(
        `<html><head>${head}</head><body><main id="main" data-composition-id="main" data-duration="2">${body}</main></body></html>`,
        emptyTimelineSettings(),
      ),
    );
  expect(
    support('<div data-start="0" data-duration="2"></div>')["clip-1"],
  ).toMatch(/unique clip id/);
  expect(
    support(
      '<div id="title" data-start="0" data-duration="2"></div>',
      '<script src="gsap.min.js"></script><style>#title{--offset:20px;translate:var(--offset) 10px}</style>',
    ).title,
  ).toMatch(/CSS translate and GSAP/);
  expect(
    support(
      '<div id="title" data-start="0" data-duration="2"></div>',
      "<style>#title{translate:20px 10px!important}</style>",
    ).title,
  ).toMatch(/important CSS translate/);
  expect(
    support(
      '<svg viewBox="0 0 640 480"><rect id="title" data-start="0" data-duration="2"/></svg>',
    ).title,
  ).toMatch(/transformed container/);
  expect(
    support(
      '<div id="title" data-start="0" data-duration="2"></div>',
      "<style>#title{translate:20px 10px}</style>",
    ),
  ).toEqual({});
});

test("a batch cannot bypass transformed ancestry by positioning a piece it just split", async () => {
  const fixture = await projectFixture();
  fixture.app.route(
    "/api/cutroom",
    createTimelineRoutes(fixture.store, fixture.review),
  );
  try {
    const project = await fixture.store.create({ name: "Scaled split" });
    const path = `/projects/${project.id}`;
    const source =
      '<main id="main" data-composition-id="main" data-fps="30" data-duration="2" style="transform:scale(.5)"><div id="title" data-start="0" data-duration="2">Title</div></main>';
    const file = join(project.path, "index.html");
    await writeFile(file, source);
    const before = TimelineViewSchema.parse(
      await (await fixture.request(`${path}/timeline`)).json(),
    );
    const response = await fixture.request(`${path}/commands`, "POST", {
      expectedRevision: before.revision,
      commands: [
        {
          type: "split",
          clipIds: ["title"],
          at: 30,
          ids: { title: ["title-end"] },
        },
        { type: "setClip", clipId: "title-end", x: 40 },
      ],
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      command: 1,
      error: "Position is unavailable inside a transformed container.",
    });
    expect(await readFile(file, "utf8")).toBe(source);
    expect(
      TimelineViewSchema.parse(
        await (await fixture.request(`${path}/timeline`)).json(),
      ).revision,
    ).toBe(before.revision);
  } finally {
    await fixture.close();
  }
});
