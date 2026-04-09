import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "index.ts",
    "session-core.ts",
    "types.ts",
    "audio.ts",
    "define-client.tsx",
    "context.ts",
    "hooks.ts",
    "components/button.tsx",
    "components/chat-view.tsx",
    "components/controls.tsx",
    "components/message-list.tsx",
    "components/sidebar-layout.tsx",
    "components/start-screen.tsx",
    "components/tool-call-block.tsx",
    "worklets/capture-processor.ts",
    "worklets/playback-processor.ts",
  ],
  format: "esm",
  target: "es2022",
  outDir: "dist",
  dts: false,
  outExtensions: () => ({ js: ".js" }),
  deps: { neverBundle: [/^[^./]/] },
});
