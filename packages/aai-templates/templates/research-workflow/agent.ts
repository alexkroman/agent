// Copyright 2026 the AAI authors. MIT license.
/**
 * A voice agent that hands work off to a durable workflow — the worked example
 * for `agent({ workflows })`.
 *
 * This is the HANDOFF shape: a caller is on the line, so a tool starts a run and
 * answers the turn. When the workflow IS the product — a form rather than a
 * call — the agent is declared with `workflowApp()` instead and has no session
 * at all; `link-digest` is that one, at its smallest.
 *
 * The whole point is the thing a voice agent cannot otherwise do: **answer the
 * caller now, finish the work later.** Research takes minutes; the caller is on
 * the line. So `request_research` starts a run and returns in the same turn, the
 * run outlives the call, and a LATER call reads the result back.
 *
 * ## The four tools are four files
 *
 * `tools/` is the tool list — a file there IS a tool, named by its own filename —
 * so this module declares the agent and the workflow it hands off to, and nothing
 * about tools. The declaration they all share lives in `shared.ts`, because a
 * tool starts a run by passing the DEFINITION rather than its name.
 *
 * ## And it SAYS SO when the work lands
 *
 * `start(…, { notify })` is what closes the loop that used to be open: the agent
 * promised an update, the run finished, and nothing made it speak — the caller
 * had to think to ask again. With it, a finished run takes an unprompted,
 * interruptible turn on this session, built from the run's own output.
 *
 * Two limits worth knowing, both by construction. It reaches the session that
 * STARTED the run, only while that session is alive — an announcement into a
 * call that has ended is nobody's — and it needs a transport that can take an
 * unprompted turn, which pipeline mode can and S2S cannot. That is why `key`
 * stays: the next call still finds the run.
 *
 * ## The correlation key is what makes the second call possible
 *
 * `start()` hands back a `runId`, and the obvious place for a tool to keep it is
 * a `sessionSlot` — which is swept shortly after the caller hangs up. So the
 * run outlives the session and the only handle to it does not. Passing
 * `{ key: ctx.sessionId }` puts the run in an index the agent can search later
 * with `find`, without maintaining its own table.
 *
 * `ctx.sessionId` keys THIS call. A real desk would key on something that
 * survives across calls — the caller's phone number, an account id — so
 * "what happened to my research?" works from a different session. The mechanism
 * is identical; only the key changes.
 *
 * ## What is NOT here
 *
 * No step function and no waitpoint. The body composes them with `ctx.step`
 * and suspends with `ctx.sleep`; the functions themselves live in
 * `workflows/research.ts`. What `agent.ts` owns is declaring the workflow and
 * the two tools that start and read runs.
 *
 * ## The research is real, and it really searches the web
 *
 * `workflows/research.ts` is a deep-research pass, not three model calls in a
 * row: it writes a brief, plans the angles worth pursuing, gives each angle its
 * own researcher step that SEARCHES and READS until its budget runs out, asks
 * what is still unanswered, and only then writes the report. The search and the
 * page reads go through `webSearch`/`visitWebpage` from `@alexkroman1/aai/tools`
 * — the same implementations behind the model-facing builtins, which is the
 * point: a step is not a lesser environment than a tool body.
 *
 * The model calls go through the same `ASSEMBLYAI_API_KEY` this agent's voice
 * pipeline uses. A step is handed no `ToolContext`, so it reads that key with
 * `requireStepEnv` rather than `ctx.env`; see that file's module doc for the one
 * thing that changes under `aai dev` (the key has to be in `.env`, not just your
 * shell).
 *
 * Runs are DURABLE on the platform with nothing to configure — they live on the
 * platform's own database and survive a restart, a redeploy and an idle sandbox.
 *
 * A `DATABASE_URL` you supply (a secret when deployed, `.env` under `aai dev`)
 * buys the key index, which is what lets `find()` resolve a run by key across a
 * restart. Under `aai dev` with none, the runs go with the process too —
 * everything below still works, which is what lets you try it first.
 */

import { agent } from "@alexkroman1/aai";
import { research } from "./shared.ts";

export default agent({
  name: "Research Desk",
  greeting: "Research desk. What would you like me to look into?",
  systemPrompt: [
    "You take research requests over the phone and read back results.",
    "When someone asks you to research something, call request_research and tell them",
    "you have started it — do NOT wait for it or promise a time. You WILL be told",
    "when it lands, so it is safe to say you will let them know.",
    "When someone asks about earlier work, call research_status.",
    "If they ask what is happening right now, call research_progress.",
    "If they say they need it immediately, call file_it_now.",
    "Keep replies to one or two sentences; this is a voice call.",
  ].join(" "),

  workflows: { research },
});
