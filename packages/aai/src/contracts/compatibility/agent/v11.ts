// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:agent` epoch 11.
 *
 * Epoch 12 added ONE optional field, `AgentDef.turnDetection` —
 * `"auto" | "manual"`, the second of which is push-to-talk: the CLIENT ends
 * each turn rather than a pause. It rides `PipelineVoiceTuning`, so an S2S or
 * text agent refuses it at the type and at the config gate like every other
 * pipeline-only knob. Nothing an epoch-11 author wrote moved to reach it: an
 * agent that leaves it out is an `"auto"` agent, which is what every agent
 * was before the field existed.
 *
 * ## What this file has to name
 *
 * Epoch 11's own addition was the roster — `agent({ personas })` — so the
 * agent below declares one, written the way an epoch-11 author did, with no
 * `turnDetection` anywhere in it. `v1.ts` through `v10.ts` carry every other
 * export of epoch 11, and epoch 11 added no name to epoch 10's list.
 *
 * **Its specifiers are RELATIVE**, for the reason every frozen example's are.
 *
 * @module
 */

import type { AgentDef } from "../../../index.ts";
import { agent, persona, personas } from "../../../index.ts";

const triage = persona({
  name: "triage",
  description: "Answers the phone, works out what the caller needs",
  systemPrompt: "Find out whether this is billing or a fault.",
});

const billing = persona({
  name: "billing",
  description: "Invoices, payments and refunds",
  systemPrompt: "Verify the account before discussing charges.",
});

/** An epoch-11 agent: a two-desk roster, and the transcriber ends each turn. */
export const desk: AgentDef = agent({
  name: "Front desk",
  greeting: "Front desk. How can I help?",
  personas: personas([triage, billing]),
});
