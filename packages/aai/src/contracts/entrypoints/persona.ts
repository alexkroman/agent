// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `persona`.
 *
 * WHO the model may route to, as one roster: the `roster()` handle over
 * `speaker()` definitions, who is on the line and how they came to be, the
 * handoff an author makes from a tool body and what it answers, and the names
 * of the two tools the roster mints (`handoff`, `delegate`). The definition
 * itself and the off-line run are `subagent`'s.
 *
 * Its own capability rather than part of `agent` or `dialog`: `agent` is what
 * an author writes to declare the agent, `dialog` is where the conversation is,
 * and this is who is talking — the three move for different reasons. The
 * `roster` FIELD on `AgentDef` is covered by `agent`, whose report names
 * `AgentDef`; a dialog state's `persona` pin is covered by `dialog`.
 *
 * Re-exported from `@alexkroman1/aai`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  DELEGATE_TOOL_NAME,
  HANDOFF_TOOL_NAME,
  type HandoffOptions,
  type HandoffResult,
  type Roster,
  roster,
  type SpeakerPosition,
} from "../../index.ts";
