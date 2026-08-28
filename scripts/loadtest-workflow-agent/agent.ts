// The workflow app `scripts/loadtest-runs.mjs` drives.
//
// Copied over a scaffolded project by `scripts/loadtest-boot.sh workflow`. It
// declares no providers and reaches no vendor, so every millisecond in a run is
// the durable engine's: enqueue, claim, execute, journal, resume.
//
// `workflowApp()` rather than `agent()` because there is nothing to talk to —
// which also means `stt`/`llm`/`tts`, `tools` and `systemPrompt` are compile
// errors here rather than fields that quietly do nothing.
import { workflow, workflowApp } from "@alexkroman1/aai";
import { z } from "zod";
import { chainFlow, fanoutFlow, napFlow } from "./workflows/load.ts";

export const chain = workflow({
  description: "N journaled steps in a straight line",
  input: z.object({
    steps: z.number().int().min(1).max(200),
    // The per-step CPU, so a run can be made step-bound or body-bound on
    // purpose. Default small: the round trip around a step is the subject.
    spin: z.number().int().min(0).max(1_000_000).optional(),
  }),
  run: chainFlow,
});

export const fanout = workflow({
  description: "items HTTP calls from steps, at width concurrency",
  input: z.object({
    // The stub endpoint, passed as INPUT rather than read from the env: a run's
    // input is journaled, so a replay dials the same place, and the driver can
    // point one run somewhere else without a redeploy.
    url: z.string(),
    items: z.number().int().min(1).max(500),
    width: z.number().int().min(1).max(64).optional(),
    // Whether a refusal is thrown as the DevKit's `RetryableError` or returned
    // as a status — the retry path against the throughput path. See `fetchOne`.
    classify: z.boolean().optional(),
  }),
  run: fanoutFlow,
});

export const nap = workflow({
  description: "a step, a durable sleep, then a step",
  input: z.object({ ms: z.number().int().min(1).max(600_000) }),
  run: napFlow,
});

export default workflowApp({
  name: "Load Test Workflows",
  workflows: { chain, fanout, nap },
});
