import { defineConfig } from "vitest/config";
import { sharedConfig } from "../../vitest.shared.ts";

// Template agents import prompt files with Vite's native `?raw` suffix
// (`import systemPrompt from "./system-prompt.md?raw"`), which vitest
// resolves out of the box — no custom raw-text plugin needed.
export default defineConfig({
  ...sharedConfig,
  test: {
    restoreMocks: true,
    include: ["templates.test.ts", "templates/*/agent.test.ts"],
  },
});
