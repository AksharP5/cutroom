# Validation

Final patch: `7d78205297dba48c71728276c3a52836faded256`, based on `df914b8`.

- Formatting and TypeScript pass, including workflow YAML formatting.
- Unit tests: 435 pass, 5 existing environment-dependent skips, 0 failures.
- Full functional suite on base `81ba7b5`: 148 pass. The two performance cases pass in a fresh backend immediately afterward.
- After rebasing onto viewer handoff `df914b8`: all 23 viewer, timeline, mix and stacking cases pass, then both performance cases pass with their own backend. `latest-base-400.json` and `latest-base-500.json` hold these single-run budget measurements.
- The three-run UI benchmark passes on both sizes; the same-base before build exceeds the 400-clip ripple ceiling.
- The existing engine benchmark passes. `engine-latest.json` is the final run. An additional run while another full browser suite was active measured request 78.45 ms against its 50 ms budget. After the browser suites finished, the unchanged benchmark measured 38.94 ms. No budget was relaxed.

The strict UI ceilings use a fresh backend. Long-session outliers and the 500-clip ripple tradeoff are recorded in README.md and the PR.
