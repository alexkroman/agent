import { defineUnitProject } from "../../vitest.shared.ts";

export default defineUnitProject({
  name: "aai",
  // `contracts/` is re-export lists and tsc-only fixtures, never executed.
  coverageExclude: ["src/contracts/**"],
  thresholds: { lines: 92, functions: 88, branches: 83, statements: 90 },
  test: {
    // One module graph per worker, not per file: this suite spent 37% of its
    // wall time evaluating the same 627 modules once per spec file (13,355
    // evaluations), and 42.8s became 10s with isolation off. What makes the
    // SDK eligible: `sdk/` holds no process-wide state a spec mutates and
    // leaves — every spy, env var and global is undone before each test by
    // the shared config, and the per-session registries (`_slot-owners.ts`)
    // are keyed by store, not module. A package that opens sockets or
    // installs dispatchers stays on `forks` with isolation (the table in
    // `.agents/testing.md`). Validated on four shuffle seeds before landing.
    isolate: false,
  },
});
