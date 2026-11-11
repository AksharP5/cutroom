import { expect, test } from "bun:test";
import { fileFingerprint } from "../src/shared/media";

test("file versions distinguish a path, size, and modification time without reading media", () => {
  const info = { size: 1234, mtimeMs: 1700000000123.456 };
  const version = fileFingerprint("assets/card.png", info);
  // Keep the review fingerprint stable so existing accepted marks survive this change.
  expect(version).toBe('["assets/card.png",1234,1700000000123.456]');
  expect(fileFingerprint("assets/card.png", { ...info })).toBe(version);
  expect(fileFingerprint("assets/other.png", info)).not.toBe(version);
  expect(fileFingerprint("assets/card.png", { ...info, size: 1235 })).not.toBe(
    version,
  );
  expect(
    fileFingerprint("assets/card.png", {
      ...info,
      mtimeMs: info.mtimeMs + 0.001,
    }),
  ).not.toBe(version);
});
