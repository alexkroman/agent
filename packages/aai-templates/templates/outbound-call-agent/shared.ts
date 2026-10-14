// Copyright 2026 the AAI authors. MIT license.
/**
 * The call workflow's DECLARATION and the request schema `POST /api/v1/calls`
 * validates against — in a module `agent.ts`, the routes and the specs can all
 * import. The body is `workflows/call.ts`.
 */

import { type WorkflowDef, workflow } from "@alexkroman1/aai";
import { z } from "zod";
import type { CallRecord } from "./api-types.ts";
import { MAX_PROMPT_CHARS } from "./call-params.ts";
import { callFlow } from "./workflows/call.ts";

/** An E.164 number: a `+`, a country code, and up to fifteen digits in all. */
const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * What `POST /api/v1/calls` accepts. Field names are snake_case because they
 * are the public API's, exactly as the curl example writes them.
 */
export const callRequest = z.object({
  phone_number: z.string().regex(E164, "phone_number must be E.164, like +14155550132"),
  prompt: z
    .string()
    .trim()
    .min(1, "prompt is required")
    .max(MAX_PROMPT_CHARS, `prompt is at most ${MAX_PROMPT_CHARS} characters`),
  webhook_url: z.url({ protocol: /^https?$/ }).optional(),
});

const callInput = callRequest.extend({
  id: z.string().describe("This app's call id — the run is keyed by it"),
  created_at: z.number().describe("Epoch ms the call was requested"),
});

/**
 * One phone call, start to finish. Annotated so `typeof call` does not depend
 * on the body's own signature (see "ANNOTATE the def" in the workflows guide).
 */
export const call: WorkflowDef<typeof callInput, CallRecord> = workflow({
  description: "Place one phone call, follow it to the end, and write up what was said",
  input: callInput,
  run: callFlow,
});
