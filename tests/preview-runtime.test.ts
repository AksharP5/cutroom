import { expect, test } from "bun:test";
import { previewRuntimeScript } from "../src/server/hyperframes/previewRuntime";

// Two changes to the same runtime text once dropped the later one, leaving calls to a
// helper it defined; every editing proxy swap then failed in the browser.
test("the preview runtime applies every Cutroom change", () => {
  const script = previewRuntimeScript();
  expect(script).toContain("function cutroomCanProxy(e)");
  expect(script).toContain("rl(document)&&t?.browserHostile");
});
