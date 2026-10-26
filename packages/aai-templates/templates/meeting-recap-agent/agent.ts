// Copyright 2026 the AAI authors. MIT license.
/**
 * A voice agent over a durable, compensating workflow — the Temporal patterns
 * ported to a phone call.
 *
 * The desk transcribes a recording and writes it up. That takes minutes, and
 * the caller is on the line for seconds, so the shape is
 * `research-handoff-agent`'s: a tool starts a run and answers the turn, the run
 * outlives the call, and the finished run takes an unprompted turn to read the
 * result back.
 *
 * What this template is FOR is the other half — the four things a caller can do
 * to a run in flight, which are the Temporal Workflow-API samples with a
 * microphone in front of them:
 *
 * | Temporal sample | Ported here as |
 * | --- | --- |
 * | `signals-queries` — Query | the `workflow_status` builtin, reading `describeRun`'s line aloud |
 * | `signals-queries` — Workflow Cancellation | the `workflow_cancel` builtin, with `cancelNote` |
 * | workflow-id reuse / `mutex` — one run per entity | the live-run check in `request_recap` |
 * | `timer-progress` — progress reporting | the `workflow_progress` builtin, over the run's own stream |
 * | `expense` — the approver's signal | `keep_transcript`, answering the retention gate |
 *
 * The durable half — the saga, the poll, the gate — is `workflows/recap.ts`,
 * which is also the declaration: its default export is registered as `recap`.
 *
 * ## Why a voice call is the honest front door for these
 *
 * Every one of these patterns exists because SOMEBODY IS WAITING and the work
 * is not done. A phone call makes that concrete: the caller cannot see a
 * spinner, cannot refresh, and will ask "is it done yet?" out loud — which is a
 * Query — and "forget it, cancel that" — which is a Cancellation. The Temporal
 * samples model an operator with a CLI; this models the same operator with a
 * phone, and the mechanism underneath is identical.
 *
 * ## One thing does NOT port, and it matters
 *
 * **Cancellation is not cooperative.** Temporal delivers cancellation INTO the
 * workflow, so the saga's `catch` runs and the compensations unwind.
 * `ctx.workflows.cancel` marks the run cancelled and stops replaying it — the
 * body's `catch` never runs, so a cancelled recap leaves its transcript on the
 * account. The declaration's `cancelNote` says so rather than pretending
 * otherwise, and the compensation stack covers the case it really does cover:
 * FAILURE. A cooperative stop would be a second hook raced alongside the work;
 * this template deliberately stops at one.
 *
 * ## What it needs
 *
 * `ASSEMBLYAI_API_KEY` in the agent env — `.env` under `aai dev`, `aai secret
 * put` once deployed. The run really submits the recording, really polls it,
 * and really deletes it when it has to. A `DATABASE_URL` is what lets a parked
 * run be found by key across a restart; under `aai dev` with none, the runs go
 * with the process.
 */

import { agent } from "@alexkroman1/aai";

export default agent({
  name: "Recap Desk",
  listing: "Transcribes meeting recordings and reads the write-up back when it lands",
  greeting: "Recap desk. Want me to write up a recording?",
  builtinTools: ["workflow_status", "workflow_progress", "workflow_cancel"],
  // Checked at deploy time: the steps read this key with `requireStepEnv`, and a
  // missing one should fail the deploy rather than the first run.
  requiredEnv: ["ASSEMBLYAI_API_KEY"],
});
