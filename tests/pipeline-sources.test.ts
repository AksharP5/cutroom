import { expect, test } from "bun:test";
import { sourceCache } from "../src/client/pipeline/sources";

test("a file that fails to open is not opened again until the next plan", async () => {
  const opens: string[] = [];
  const cache = sourceCache(async (path) => {
    opens.push(path);
    if (path === "broken.mp4") throw new Error("The file has no video track.");
    return path;
  });
  // Every frame asks again.
  for (let frame = 0; frame < 3; frame++) {
    await expect(cache.get("broken.mp4")).rejects.toThrow("no video track");
    expect(await cache.get("talk.mp4")).toBe("talk.mp4");
  }
  expect(opens).toEqual(["broken.mp4", "talk.mp4"]);
  cache.forgetFailures();
  await expect(cache.get("broken.mp4")).rejects.toThrow();
  expect(await cache.get("talk.mp4")).toBe("talk.mp4");
  expect(opens).toEqual(["broken.mp4", "talk.mp4", "broken.mp4"]);
});
