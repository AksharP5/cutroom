# HyperFrames source

Cutroom builds core, engine, lint, parsers, producer and studio-server from [HyperFrames v0.9.26](https://github.com/heygen-com/hyperframes/tree/0c6c7fca45bddc9838ebc6c0f0280e9efea1f18a). The source lives in `vendor/hyperframes` with its Apache-2.0 license. The published `hyperframes` CLI stays pinned separately for transcription and Library compatibility.

`bun install --frozen-lockfile` builds the packages after installing Cutroom. `bun run build:hyperframes` rebuilds them after a source or patch edit. The build works in a temporary copy, uses the vendor lockfile, and applies the existing Cutroom patches to the same file set as the npm packages. Bun links the results in `vendor/@hyperframes` so both Bun and the Node render worker resolve the packages against Cutroom's dependencies.

The workspace manifests keep the published entry points, package metadata and runtime dependency ranges. They omit upstream scripts and development dependencies so Cutroom's install only pulls the build tools via the separate vendor workspace. The portable Linux package carries the built files and installs their runtime dependencies at packaging time.

## Update the source

1. Start with the upstream commit for the release you want. Copy updates into `vendor/hyperframes` using the upstream paths. Keep the six packages, their build scripts, `.oxfmtrc.json` and the license. The initial snapshot omits upstream test suites, large regression fixtures, and other workspaces. Keep fixture modules which the production TypeScript build includes.
2. Update `vendor/hyperframes/package.json` for the new source and refresh the vendor lockfile with `(cd vendor/hyperframes && bun install --lockfile-only)`. The root manifest is a reduced copy of upstream's build workspace. The core manifest omits test and font-generation dependencies because the published font data is tracked. The producer manifest omits the AWS Lambda development dependency because its entry point is excluded from the build. These two manifests are the only upstream package files changed in the initial snapshot.
3. Review every patch in `patches/` against the new build. Recreate the patches you still need against the published file layout and name them for the new package version. Then run `bun run build:hyperframes --update-manifests` and `bun install` to refresh the runtime workspace manifests and Cutroom's lockfile.
4. Check the pinned CLI and Library release and the load-time checks in `src/server/hyperframes/previewRuntime.ts` and `src/server/hyperframes/renderIsolation.ts`. Run Cutroom's type checks, Bun tests, browser tests and portable build. When importing unmodified upstream source, compare the result with the matching npm packages before applying Cutroom's patches.

Keep upstream license and copyright notices. Mark every upstream file Cutroom edits with a prominent change notice. For package manifests, use `x-cutroom-modified`.
