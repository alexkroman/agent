// Copyright 2026 the AAI authors. MIT license.
/**
 * Running a tool call: the executor and its toolset dispatcher (`executor.ts`),
 * argument coercion and call repair, the error policy and its fatal latch, tool
 * speech (`messages-runner.ts`), the AI SDK adapter (`to-vercel-tools.ts`), the
 * builtin surface, the `role: "tool"` message shape (`result-message.ts`), the
 * client-tool broker and `withToolsDir`. `subagent.ts` stays outside: it opens a
 * model, and this index must not pull the provider registry into every importer.
 * Outside this directory, import from here; a name not re-exported here is
 * private to it (guard-invariants rule 37).
 */

export { mergeBuiltinSurface } from "./builtin-surface.ts";
export { pairToolCalls, pairToolCallsInPlace, pairToolCallsLogged } from "./call-pairs.ts";
export { createToolCallRepair, salvageJson } from "./call-repair.ts";
export type { ClientToolAnswer, ClientToolBroker } from "./client-tool-broker.ts";
export { createClientToolBroker } from "./client-tool-broker.ts";
export type { FatalToolLatch } from "./error-policy.ts";
export { createFatalToolLatch, FatalToolError, withFatalSignal } from "./error-policy.ts";
export type {
  ExecuteTool,
  ExecuteToolOptions,
  SubagentRunner,
  ToolCallDefaults,
} from "./executor.ts";
export { createToolDispatcher, executeToolCall } from "./executor.ts";
export type { ToolSpeechController } from "./messages-runner.ts";
export { awaitSpokenEstimate, createToolSpeechController } from "./messages-runner.ts";
export { toolResultMessage } from "./result-message.ts";
export { stringifyResult } from "./result-text.ts";
export { toDeclaredTools, toVercelTools } from "./to-vercel-tools.ts";
export { withToolsDir } from "./tools-dir.ts";
