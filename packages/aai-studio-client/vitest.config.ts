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
    exclude: ["node_modules", "dist"],
    // Raises Testing Library's 1000ms async-utility ceiling — see the file.
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
      // Actuals (2026-08): lines 98.96, functions 98.13, branches 94.53, statements 98.04.
      thresholds: { lines: 96, functions: 94, branches: 93, statements: 95 },
    },
  },
});
