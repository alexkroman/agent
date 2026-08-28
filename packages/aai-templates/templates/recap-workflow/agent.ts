// Copyright 2026 the AAI authors. MIT license.
/**
 * A voice agent over a durable, compensating workflow — the Temporal patterns
 * ported to a phone call.
 *
 * The desk transcribes a recording and writes it up. That takes minutes, and
 * the caller is on the line for seconds, so the shape is `research-workflow`'s: a
 * tool starts a run and answers the turn, the run outlives the call, and the
 * finished run takes an unprompted turn to read the result back.
 *
 * What this template is FOR is the other half — the four things a caller can do
 * to a run in flight, which are the Temporal Workflow-API samples with a
 * microphone in front of them:
 *
 * | Temporal sample | Ported here as |
 * | --- | --- |
 * | `signals-queries` — Query | `recap_status`, reading a run snapshot aloud |
 * | `signals-queries` — Workflow Cancellation | `cancel_recap` |
 * | workflow-id reuse / `mutex` — one run per entity | the live-run check in `request_recap` |
 * | `timer-progress` — progress reporting | `recap_progress`, over the run's own stream |
 *
 * The durable half — the saga, the poll loop, the timer race — is in
 * `workflows/recap.ts`, which carries its own table. Each of the five tools is
 * its own file under `tools/`, named for the tool the model calls; the
 * declaration they share is in `shared.ts`, because a tool reaches a run by
 * passing the DEFINITION rather than its name.
 *
 * ## Why a voice call is the honest front door for these
 *
 * Every one of these patterns exists because SOMEBODY IS WAITING and the work
 * is not done. A phone call makes that concrete in a way a form does not: the
 * caller cannot see a spinner, cannot refresh, and will ask "is it done yet?"
 * out loud — which is a Query — and "forget it, cancel that" — which is a
 * Cancellation. The Temporal samples model an operator with a CLI. This models
 * the same operator with a phone, and the mechanism underneath is identical.
 *
 * ## The gate is why the SDK grew `ctx.workflows.signal()`
 *
 * `expense` is the most voice-native sample Temporal ships — a run that waits
 * for a person to say yes — and it was unportable here until this template
 * asked for it. The DevKit's only reachable waitpoint was `createWebhook()`,
 * whose URL is minted for a THIRD PARTY with a callback to make; the caller is
 * not that, they are on the line right now, and the thing that should resume
 * the run is a tool. `signal(token, payload)` is that, and
 * `tools/keep_transcript.ts` is four lines because of it.
 *
 * ## One thing still does NOT port, and it matters
 *
 * **Cancellation is not cooperative.** Temporal delivers cancellation INTO the
 * workflow, so the saga's `catch` runs and the compensations unwind.
 * `ctx.workflows.cancel` marks the run cancelled and stops replaying it — the
 * body's `catch` never runs, so a cancelled recap leaves its transcript on the
 * account. `cancel_recap` says so rather than pretending otherwise, and the
 * compensation stack covers the case it really does cover: FAILURE.
 *
 * The gate is what a cooperative stop would be built from — a hook the body
 * races alongside its work, signalled instead of cancelling — and this template
 * deliberately stops at one hook. Racing a stop into every wait is a second
 * lesson, and it would cost this one its shape.
 *
 * ## What it needs
 *
 * `ASSEMBLYAI_API_KEY` in the agent env — `.env` under `aai dev`, `aai secret
 * put ASSEMBLYAI_API_KEY` once deployed. The same key the voice pipeline uses;
 * the run really submits the recording, really polls it, and really deletes it
 * when it has to.
 *
 * Runs are DURABLE on the platform with nothing to configure, so a recap parked
 * on a callback survives a restart, a redeploy and an idle sandbox.
 *
 * A `DATABASE_URL` you supply moves the correlation-key index out of memory,
 * which is what lets `find()` resolve that parked run by key afterwards. Under
 * `aai dev` with none, both the runs and the index go with the process: the flow
 * still runs, it just does not outlive the server.
 */

import { agent } from "@alexkroman1/aai";
import { recap } from "./shared.ts";

export default agent({
  name: "Recap Desk",
  greeting: "Recap desk. Want me to write up a recording?",
  systemPrompt: [
    "You take recordings over the phone, hand them to a transcription run, and read back recaps.",
    "When someone asks you to write up a recording, call request_recap and tell them you have",
    "started it — do NOT wait for it or promise a time. You WILL be told when it lands, so it is",
    "safe to say you will let them know.",
    "When the run asks whether to keep the transcript, relay the question and call",
    "keep_transcript with their answer.",
    "If they ask how it is going, call recap_progress. If they ask about earlier work, call",
    "recap_status. If they say to stop or forget it, call cancel_recap.",
    "Keep replies to one or two sentences; this is a voice call.",
  ].join(" "),

  workflows: { recap },

  // Checked at deploy time: the steps read this key with `requireStepEnv`, and a
  // missing one should fail the deploy rather than the first run.
  requiredEnv: ["ASSEMBLYAI_API_KEY"],
});
