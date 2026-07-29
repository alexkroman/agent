import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    restoreMocks: true,
    // Most tests render via react-dom/server in node; interaction tests
    // (app.test.tsx, code-view.test.tsx) opt into jsdom with a per-file
    // `@vitest-environment` pragma.
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules", "dist"],
    coverage: {
      // The pane components are browser-heavy (CodeMirror, useChat
      // streaming, the live iframe) and only their extracted logic
      // (toBlocks, useFileDraft, the 401 wiring) is tested here — so they
      // are excluded from the *floors*, which govern the fully
      // node-testable modules. The behavior tests still run either way.
      exclude: [
        ...sharedCoverageExclude,
        "src/main.tsx",
        "src/app.tsx",
        "src/chat.tsx",
        "src/code-view.tsx",
        "src/preview.tsx",
        "vite.config.ts",
      ],
      // Ratchet: floors only move up. Raise to ~2-3 points below actuals
      // whenever a coverage run shows comfortable headroom.
      // Actuals (2026-07): lines ~88%, functions ~84%, branches ~92%, statements ~89%.
      thresholds: { lines: 85, functions: 80, branches: 89, statements: 86 },
    },
  },
});
