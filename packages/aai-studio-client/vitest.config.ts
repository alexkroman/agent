import { defineUnitProject } from "../../vitest.shared.ts";

export default defineUnitProject({
  name: "aai-studio-client",
  // Node by default; interaction tests opt into jsdom per file.
  include: ["**/*.test.{ts,tsx}"],
  // Raises Testing Library's async ceiling to 10s and unmounts every render.
  setupFiles: ["./src/_test-setup.ts"],
  // Above the setup file's 10s ceiling, so a slow `waitFor` keeps its message.
  test: { testTimeout: 20_000 },
  // Browser-heavy panes whose extracted logic is tested elsewhere. `auth.tsx`'s
  // decisions are `auth-state.ts`'s (covered); what is left is the React bridge
  // and supabase-js wiring (an auth subscription, an OAuth redirect) no unit
  // spec reaches.
  coverageExclude: [
    "src/main.tsx",
    "src/app.tsx",
    "src/auth.tsx",
    "src/project-view.tsx",
    "src/components/gates.tsx",
    "src/panes/chat.tsx",
    "src/panes/code-view.tsx",
    "src/panes/preview.tsx",
    "vite.config.ts",
  ],
  thresholds: { lines: 96, functions: 94, branches: 93, statements: 95 },
});
