// Copyright 2026 the AAI authors. MIT license.
/**
 * Text mode: `createTextAgent` drives an agent's model turns from text, with
 * the same tool loop, budget and subagents a voice session has (`agent.ts`),
 * the session events it reports (`events.ts`) and the message bookkeeping
 * behind `ctx.messages` (`messages.ts`). `TEXT-AGENT-CLAUDE.md` beside the
 * package guide has the rules. Outside this directory, import from here; a name
 * not re-exported here is private to it (guard-invariants rule 37).
 */

export type { TextAgent, TextAgentOptions, TextTurnOptions, TextTurnResult } from "./agent.ts";
export { createTextAgent, textAgentHasNoSession } from "./agent.ts";
