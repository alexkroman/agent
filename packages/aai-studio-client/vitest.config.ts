import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    // Project name for `--project aai-studio-client`; the workspace root discovers this
    // file by glob, so the name must live here (else it defaults to the
    // package.json name).
    name: "aai-studio-client",
    // Most tests render via react-dom/server in node; interaction tests
    // (app.test.tsx, code-view.test.tsx) opt into jsdom with a per-file
    // `@vitest-environment` pragma.
    include: ["**/*.test.{ts,tsx}"],
    // Both slow-tier infixes, per the convention in the root guide — excluded
    // here so a new one lands in its own tier with no config edit. This
    // package owns none of either today, which is exactly when the gap is
    // invisible: without these, renaming a file to `*.scenario.test.tsx`
    // leaves it running in the unit tier under a 20s budget instead.
    exclude: [
      "**/*.integration.test.{ts,tsx}",
      "**/*.scenario.test.{ts,tsx}",
      "node_modules",
      "dist",
    ],
    // Same contended-check-run headroom rationale as aai-server and
    // aai-studio-server. Without it vitest's 5000ms default applies and the
    // setup file's 10s Testing Library ceiling is unreachable: a `waitFor`
    // that needs 5-10s aborts as "Test timed out in 5000 ms", discarding the
    // assertion message the setup file exists to preserve — and two tests in
    // app.test.tsx already ask for 4000ms waits on top of an `openProject`
    // wait in the same test.
    testTimeout: 20_000,
    // Raises Testing Library's 1000ms async-utility ceiling, and unmounts
    // every render — see the file.
    setupFiles: ["./src/_test-setup.ts"],
    coverage: {
      // The pane components are browser-heavy (CodeMirror, useChat
      // streaming, the live iframe) and only their extracted logic
      // (toBlocks, the buffer rules in file-drafts.ts, the notify dispatch,
      // the 401 wiring) is tested here — so they are excluded from the
      // *floors*, which govern the fully node-testable modules. The behavior
      // tests still run either way.
      exclude: [
        ...sharedCoverageExclude,
        "src/main.tsx",
        "src/app.tsx",
        "src/project-view.tsx",
        "src/gates.tsx",
        "src/chat.tsx",
        "src/code-view.tsx",
        "src/preview.tsx",
        "vite.config.ts",
      ],
      // Ratchet: floors only move up. Raise to ~2-3 points below actuals
      // whenever a coverage run shows comfortable headroom.
      // Actuals (2026-08): lines 98.98, functions 98.14, branches 94.57, statements 98.07.
      // `auth.tsx` is NOT excluded and is deliberately never LOADED by a test:
      // it is supabase-js, an auth-state subscription and an OAuth redirect. Its
      // testable half lives in `auth-methods.ts`, which the floors do govern —
      // which is why a test importing a value from `auth.tsx` would drop the
      // whole package ~11 points without covering anything new.
      thresholds: { lines: 96, functions: 94, branches: 93, statements: 95 },
    },
  },
});
