// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `persona`.
 *
 * WHO is speaking, as a roster the session hands the caller between mid-call:
 * the `persona()` declaration, the `personas()` roster and its handle, the
 * handoff an author makes from a tool body and what it answers, and the name
 * of the tool the roster mints for the model to route with.
 *
 * Its own capability rather than part of `agent` or `dialog`, and the reason is
 * the one the root guide gives for naming capabilities at all: `agent` is what
 * an author writes to declare the agent, `dialog` is where the conversation is,
 * and this is who is talking — the three move for different reasons. The
 * `personas` FIELD on `AgentDef` is covered by `agent`, whose report names
 * `AgentDef`; a dialog state's `persona` pin is covered by `dialog`.
 *
 * Re-exported from `@alexkroman1/aai`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  HANDOFF_TOOL_NAME,
  type HandoffOptions,
  type HandoffResult,
  type PersonaDef,
  type PersonaPosition,
  type Personas,
  persona,
  personas,
} from "../../index.ts";
