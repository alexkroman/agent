import type { PluginOption } from "vite";
import { defineConfig } from "vitest/config";
import { sharedConfig } from "../../vitest.shared.ts";

/**
 * Transform `.md`/`.txt` imports into raw string exports, mirroring the CLI
 * bundler's `raw-md` plugin (packages/aai-cli/worker-bundler.ts) so template
 * `import systemPrompt from "./system-prompt.md"` lines resolve under vitest
 * exactly as they do under `aai build`.
 */
const rawTextPlugin: PluginOption = {
  name: "raw-md-txt",
  transform(code: string, id: string) {
    if (id.endsWith(".md") || id.endsWith(".txt")) {
      return { code: `export default ${JSON.stringify(code)}`, map: null };
    }
  },
};

export default defineConfig({
  ...sharedConfig,
  plugins: [rawTextPlugin],
  test: {
    restoreMocks: true,
    include: ["templates.test.ts", "templates/*/agent.test.ts"],
  },
});
