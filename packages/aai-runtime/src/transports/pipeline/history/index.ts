// Copyright 2026 the AAI authors. MIT license.
/**
 * Conversation memory: the two-view pipeline history, the per-step context
 * budget (a `prepareStep` preparer), and the heard-history rewrite of a reply
 * already committed. May import `heard/`, `output/` (`toModelMessage`) and
 * `turn/`.
 */

export type { ContextBudgetPreparer } from "./context-budget.ts";
export { createContextBudget } from "./context-budget.ts";
export type { PersistedReply } from "./heard-history.ts";
export { createHeardHistory } from "./heard-history.ts";
export type { PipelineHistory } from "./history.ts";
export { createPipelineHistory, persistInterruptedTurn } from "./history.ts";
export {
  estimateConversationTokens,
  evictBeyondRetention,
  HISTORY_RETAIN_TOKENS,
} from "./retention.ts";
