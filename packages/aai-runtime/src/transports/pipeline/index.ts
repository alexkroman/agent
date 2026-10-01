// Copyright 2026 the AAI authors. MIT license.
/**
 * The pipeline transport (STT -> LLM -> TTS), as the rest of the runtime sees it.
 *
 * This file is the directory's whole public surface: a module outside
 * `transports/pipeline/` imports from here and nowhere else, and a name that is
 * not re-exported here is private to the pipeline. The stages behind it are
 * subdirectories, each with its own `index.ts` (`speech/`, `llm/`, `reply/`,
 * `output/`, `heard/`, `history/`, `turn/`, `knobs/`); the files beside this one
 * assemble them into one transport. guard-invariants rule 37 enforces the
 * index rule and konsistent's `pipeline-stage-*` conventions the direction
 * between stages; `CLAUDE.md` here has the map.
 */

export type { PipelineHistory } from "./history/index.ts";
export {
  createPipelineHistory,
  createRetainedView,
  estimateConversationTokens,
  evictBeyondRetention,
  HISTORY_RETAIN_TOKENS,
} from "./history/index.ts";
export type {
  DialogTurnKnobs,
  DialogTurnSource,
  PersonaInterruptionSource,
  PersonaTurnSource,
} from "./knobs/index.ts";
export { interruptionKnobs } from "./knobs/index.ts";
export type { PipelineTransportOptions } from "./options.ts";
export type { TurnGuardrails } from "./output/index.ts";
export { createTurnGuardrails } from "./output/index.ts";
export type { PipelineProviderSessions } from "./providers.ts";
export type { InReplyLineFlags } from "./reply/index.ts";
export { hasMinWords } from "./speech/index.ts";
export { createPipelineTransport } from "./transport.ts";
export { createTurnGate } from "./turn/index.ts";
export { createTurnOutcome } from "./turn-outcome.ts";
