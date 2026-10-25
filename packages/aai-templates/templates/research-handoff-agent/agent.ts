// Copyright 2026 the AAI authors. MIT license.
/**
 * A voice agent that hands work off to a durable workflow.
 *
 * This is the HANDOFF shape: a caller is on the line, so a tool starts a run and
 * answers the turn. When the workflow IS the product — a form rather than a
 * call — the agent is declared with `workflowApp()` instead and has no session
 * at all; `link-digest-workflow` is that one, at its smallest.
 *
 * The whole point is the thing a voice agent cannot otherwise do: **answer the
 * caller now, finish the work later.** Research takes minutes; the caller is on
 * the line. So `request_research` starts a run and returns in the same turn, the
 * run outlives the call, and a LATER turn — or a later call — reads the result
 * back.
 *
 * ## Two tools of its own, three the SDK ships
 *
 * `tools/request_research.ts` starts the run and `tools/file_it_now.ts` cuts its
 * review wait short. "How is it going", "what is it doing right now" and "forget
 * it" are the `workflow_status`, `workflow_progress` and `workflow_cancel`
 * builtins, which read the runs THIS session started; what they say is
 * `describeRun` and `cancelNote` on the declaration in `workflows/research.ts`.
 *
 * ## And it SAYS SO when the work lands
 *
 * `start(…, { notify })` is what makes "I'll let you know" true: a finished run
 * takes an unprompted, interruptible turn on the session that started it, built
 * from the run's own output. It reaches that session only while it is alive,
 * and only on a transport that can take an unprompted turn (pipeline, not S2S)
 * — which is why the run is also keyed: the next call still finds it.
 *
 * ## The research is real, and it really searches the web
 *
 * `workflows/research.ts` is a deep-research pass, not three model calls in a
 * row: a brief, the angles worth pursuing, one researcher per angle that
 * SEARCHES and READS until its budget runs out, a gap pass, then the report.
 * The model calls go through the same `ASSEMBLYAI_API_KEY` this agent's voice
 * pipeline uses (in `.env` under `aai dev`, not just your shell).
 *
 * ## And the finished report goes SOMEWHERE
 *
 * The run's last step files it (`workflows/filing.ts`): set
 * `RESEARCH_SLACK_WEBHOOK_URL` and a finished pass posts its summary, its
 * angles and its sources there. It is deliberately OPTIONAL — with none, the
 * desk still researches, still announces, and says the report stayed on the run
 * — because a required credential would fail the LAST step of a five-minute
 * pass. A `DATABASE_URL` is what lets a run be found by key across a restart;
 * under `aai dev` with none, the runs go with the process.
 */

import { agent } from "@alexkroman1/aai";

export default agent({
  name: "Research Desk",
  listing: "Takes research requests over the phone and reports back when the run lands",
  greeting: "Research desk. What would you like me to look into?",
  systemPrompt: [
    "You take research requests over the phone and read back results.",
    "When someone asks you to research something, call request_research and tell them",
    "you have started it — do NOT wait for it or promise a time. You WILL be told",
    "when it lands, so it is safe to say you will let them know.",
    "If they say they need it immediately, call file_it_now.",
    "Keep replies to one or two sentences; this is a voice call.",
  ].join(" "),
  builtinTools: ["workflow_status", "workflow_progress", "workflow_cancel"],
});
