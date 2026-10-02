import { defineAgentTestConfig } from "@alexkroman1/aai/testing/vite";

/**
 * The agent plugin (`virtual:aai/agent`), `globals: true`, a pinned reporter,
 * and spies, env and global stubs undone after every test — each argued for
 * where it lives, in the SDK. Pass overrides to add to it: `defineAgentTestConfig({ test: { testTimeout: 10_000 } })`.
 */
export default defineAgentTestConfig();
