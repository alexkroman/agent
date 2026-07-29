import { defineConfig } from "vitest/config";
import { sharedConfig, sharedCoverageExclude } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    restoreMocks: true,
    // Components are unit-tested via react-dom/server (no jsdom needed) —
    // see markdown.test.tsx.
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules", "dist"],
    coverage: {
      // The pane wiring (app/chat/code-view/preview) runs in the browser and
      // is exercised via the served shell in aai-server's studio-routes
      // tests; only the node-testable modules are held to a floor.
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
      // Actuals (2026-07): lines ~53%, branches ~72%, functions ~43%, statements ~52%.
      thresholds: { lines: 50, functions: 40, branches: 69, statements: 49 },
    },
  },
});
