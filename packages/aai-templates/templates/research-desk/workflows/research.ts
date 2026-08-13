// Copyright 2026 the AAI authors. MIT license.
/**
 * The durable half of the research desk: a `"use workflow"` body and its steps,
 * and the steps really call a model.
 *
 * **This file is the one place in a template where the Workflow Development Kit
 * is imported directly**, and that is deliberate: the SDK re-exports none of it.
 * An author reaches for `sleep` from `workflow` the same way they reach for `z`
 * from `zod`.
 *
 * ## Why the body is here and not in `agent.ts`
 *
 * The WDK builder scans `workflows/` at build time and rewrites every function
 * carrying a directive. `agent.ts` is not scanned, so a body written there would
 * never be transformed — it would run inline on the first call, once, with no
 * durability and no error saying so.
 *
 * ## The two rules a body has to obey
 *
 * **1. The body is replayed from the top on every resume.** So it may hold no
 * live handle and must make no undurable decision: no `Date.now()`, no
 * `Math.random()`, no model call. Everything real happens in a `"use step"`
 * function, which runs at most once per successful execution and is journaled by
 * its result.
 *
 * **2. A step's arguments and return value are serialized.** They cross a queue,
 * so they must be JSON-shaped and small. Pass an id, not a payload.
 *
 * ## The model call, and where the key comes from
 *
 * A step is handed no `ToolContext`, so `ctx.generate` is not available in one —
 * this is the difference between a step and a tool, and it used to mean a
 * template's research was a hard-coded string. `requireStepEnv`
 * (`@alexkroman1/aai/utils`) closes it: the agent env is published into the
 * process by whatever is serving the workflow, and a step reads a key out of it
 * by name. So the desk authenticates with the SAME `ASSEMBLYAI_API_KEY` the
 * voice pipeline uses, and needs no second credential.
 *
 * One consequence to know under `aai dev`: `stepEnv` answers from the agent env,
 * which is `.env` (and `aai secret put` once deployed) and NOT the shell. A key
 * exported in your shell reaches the voice providers — that is
 * `withHostCredentialFallback`, a documented dev ergonomic — and does not reach
 * a step, deliberately, because the step is agent code and must see the same
 * env after a deploy as it sees now.
 *
 * The call itself is `stepGenerate` (`@alexkroman1/aai/utils`), which is
 * `ctx.generate`'s counterpart for a step: one `fetch` to the AssemblyAI LLM
 * Gateway, on the SAME key and the SAME default model the agent's own pipeline
 * resolves. It is not the AI SDK — a step artifact bundles everything it imports
 * except the DevKit, so `ai` plus a provider would be megabytes on every deploy
 * for one chat completion. See its module doc for what that trade costs.
 *
 * ## Why the fan-out is batched
 *
 * `mapInBatches` (`@alexkroman1/aai/utils`) rather than `Promise.all` over every
 * angle: the DevKit correlates a journal entry to a step call by the ORDER the
 * call was ISSUED in, so bounded concurrency has to be sequential batches — a
 * work-stealing pool issues in completion order, which a replay does not
 * reproduce. Its module doc carries the whole argument.
 */

import { mapInBatches, report, StepGenerateError, stepGenerate } from "@alexkroman1/aai/utils";
import { FatalError, sleep } from "workflow";

/** How long the desk sits on a finished draft before filing it. */
const REVIEW_DELAY = "30 seconds";

/** Angles the desk breaks a topic into. More is slower and not obviously better. */
const ANGLES = 3;

/** Angles investigated at once — the far side is a rate limit. */
const ANGLE_CONCURRENCY = 2;

/** What one angle came back with. Small and JSON-shaped, like every step result. */
export type Note = {
  angle: string;
  note: string;
};

/** What one research pass produces. */
export type Findings = {
  topic: string;
  summary: string;
  /** How many angles were investigated — what the voice agent reads back. */
  sources: number;
  angles: string[];
};

/**
 * Research `topic` properly, sleep on it, then file the result.
 *
 * Three model calls deep at `ANGLES` of 3, and that is the point: it takes long
 * enough that a caller cannot wait for it, which is what a durable run is for.
 * The `sleep` on top suspends the run WITHOUT holding a process open, so the
 * sandbox is free to exit and the run resumes when it comes due.
 *
 * Thirty seconds is short enough to watch in `aai dev`. Nothing about the code
 * changes if it is `"6 hours"` — which is the interesting version, and the one a
 * real desk would use.
 */
export async function researchFlow(input: { topic: string; requestedBy: string }) {
  "use workflow";

  const angles = await planAngles(input.topic);

  // One step per angle, bounded, in an order a replay reproduces exactly. A
  // failed angle fails the RUN: its finished siblings are already journaled, so
  // the resume replays them for free and re-issues only what is missing, where
  // catching here would file a report with a silent hole in it.
  const notes = await mapInBatches(angles, ANGLE_CONCURRENCY, (angle) =>
    investigate(input.topic, angle),
  );

  const summary = await synthesize(input.topic, notes);

  // Suspended, not blocked. On resume the body re-runs from the top and every
  // step above returns its journaled result instead of calling the model again.
  await sleep(REVIEW_DELAY);

  // Whatever this returns is what `ctx.workflows.get(runId)` reports as `output`
  // on a completed run, so it is what the agent reads back to the caller.
  return {
    topic: input.topic,
    summary,
    sources: notes.length,
    angles: notes.map((note) => note.angle),
    filedAt: await file(input.requestedBy, input.topic),
  };
}

/**
 * Break the topic into the angles worth researching.
 *
 * The first model call, and the one the fan-out's WIDTH comes from — which makes
 * it a step rather than body code twice over: it does I/O, and its result is
 * journaled, so a resume re-derives the same list instead of asking the model
 * again and getting a different one.
 */
export async function planAngles(topic: string): Promise<string[]> {
  "use step";

  await report(`Planning angles on ${topic}.`);
  const reply = await ask(`Give exactly ${ANGLES} distinct angles worth researching on: ${topic}`, {
    system:
      "You plan research. Reply with one angle per line and nothing else — no numbering, no preamble.",
  });

  // The model was asked for one per line; a list that arrives numbered or
  // bulleted anyway is normalized rather than rejected, because a retry would
  // most likely produce the same shape.
  const angles = reply
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter(Boolean)
    .slice(0, ANGLES);

  if (angles.length === 0) {
    // Not transient: the same prompt produces the same nothing.
    throw new FatalError(`The model returned no angles on "${topic}".`);
  }
  return angles;
}

/**
 * Research one angle.
 *
 * One step each, so a run that dies part-way resumes having replayed the
 * finished angles from the journal — no re-asking, no re-billing — and issues
 * exactly the calls that are missing.
 */
export async function investigate(topic: string, angle: string): Promise<Note> {
  "use step";

  // One line per angle, which is what makes the fan-out legible: the status is
  // `running` for the whole thing, so without this a three-angle pass and a
  // one-angle pass look identical while they run. ORDER is not guaranteed and
  // does not need to be — a batch issues its calls together, so the lines
  // interleave by completion.
  await report(`Looking into: ${angle}`);

  const note = await ask(`Topic: ${topic}\nAngle: ${angle}`, {
    system:
      "You are a research analyst. Answer in one dense paragraph. State what is known, " +
      "then where the evidence thins out. No preamble, no bullet points.",
  });
  return { angle, note };
}

/** A rate limit is the expected failure on a fan-out, so retry past the default 3. */
investigate.maxRetries = 5;

/**
 * Reduce the notes to something a voice agent can read aloud.
 *
 * The notes are passed in rather than re-read, and they are the one place this
 * template bends the pass-an-id-not-a-payload rule: they are already journaled
 * as step results, so this re-serializes them once, and they are the input to
 * the reduction — there is no id that would stand for them.
 */
export async function synthesize(topic: string, notes: readonly Note[]): Promise<string> {
  "use step";

  await report(`Writing up ${notes.length} angle${notes.length === 1 ? "" : "s"}.`);
  return await ask(
    `Topic: ${topic}\n\n${notes.map((note) => `## ${note.angle}\n${note.note}`).join("\n\n")}`,
    { system: "You brief people over the phone. Two or three sentences, no lists, no preamble." },
  );
}

/**
 * File the findings.
 *
 * Separate from the research on purpose. Two steps mean a crash between them
 * replays the model calls for free and re-issues only the filing — one step
 * doing both would redo the expensive half every time the cheap half failed.
 */
export async function file(_requestedBy: string, _topic: string): Promise<string> {
  "use step";

  await report("Filing the findings.");
  // A real desk would write the findings to its database here, keyed on the two
  // names above — the `_` says this stub writes nothing, and it is a stub
  // because `ctx.db` is the half of a tool context a step still cannot reach.
  // Returning the timestamp rather than reading a clock in the BODY is the
  // journaling rule again: a step's result is stable across replays.
  return new Date().toISOString();
}

// ---- The model call ---------------------------------------------------------

/**
 * `stepGenerate`, with this desk's retry POLICY on top.
 *
 * The SDK classifies the failure (`StepGenerateError.retryable`) and stops
 * there, deliberately: whether a terminal failure should burn the step's
 * remaining attempts is the caller's call, and `FatalError` belongs to
 * `workflow`, which the SDK cannot import onto the CLI's startup path. This desk
 * takes the ordinary answer — a bad key or a rejected request will not become a
 * good one on the fourth try.
 */
async function ask(prompt: string, opts: { system: string }): Promise<string> {
  return await stepGenerate(prompt, opts).catch(stopOrRetry);
}

/**
 * Turn a terminal gateway failure into one the DevKit will not retry.
 *
 * A plain function rather than a `throw` inside a `catch`: `FatalError` takes
 * only a message — no `cause` — so constructing one in a catch block loses the
 * original error where the linter (rightly) expects it preserved. Here the
 * original is the ARGUMENT, and a retryable one is re-thrown untouched.
 */
function stopOrRetry(err: unknown): never {
  if (err instanceof StepGenerateError && !err.retryable) throw new FatalError(err.message);
  throw err;
}
