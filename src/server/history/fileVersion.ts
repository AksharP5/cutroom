// Copyright 2026 HeyGen, Inc.
// SPDX-License-Identifier: Apache-2.0
// From heygen-com/hyperframes v0.9.26, packages/studio-server/src/helpers/fileVersion.ts.
// Modified by Cutroom. See THIRD_PARTY_NOTICES.md.

export function hashVersion(hex: string): string {
  return `"sha256:${hex}"`;
}

/** The sha256 a version names, or undefined when it is not a content version. */
export function hashOfVersion(version: string): string | undefined {
  return /^"sha256:([0-9a-f]{64})"$/.exec(version)?.[1];
}
