# Cutroom

Cutroom is a local video studio. Projects are ordinary HyperFrames folders. Keep project data on disk, preserve source media, and use the same editing and history operations from the UI and MCP.

- Use Bun, TypeScript, React, and the pinned public HyperFrames packages.
- Run `bun run check`, `bun test`, and the relevant Playwright workflow before shipping behavior changes.
- Native agents own their skills, configuration, and sessions. Do not copy their skill libraries or replace their runtimes with a separate model loop.
- Keep the interface original. No proprietary desktop code, branding, mascots, remote accounts, or hosted integrations.
- Preserve third-party licenses and document public-source adaptations in `THIRD_PARTY_NOTICES.md`.
- Validate external input at the owning boundary. Avoid `any`, unchecked assertions, duplicate state, and speculative abstractions.
- Keep the README focused on installation and use. Put architecture details in `docs/`.
