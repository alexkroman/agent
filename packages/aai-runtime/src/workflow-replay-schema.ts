// Copyright 2026 the AAI authors. MIT license.
/**
 * The two values a durable body handles that nothing checked: a hook's PAYLOAD
 * and a step's JOURNALED OUTPUT.
 *
 * Both were typed by a type parameter and cast into place — `answered.payload as
 * T` in `workflow-replay-waits.ts`, `entry.output as T` in `workflow-replay.ts`
 * — and a cast is a claim the compiler believes and no one verified. `ctx.step`'s
 * own doc had said so about the payload for as long as the method existed ("the
 * type parameter is a claim about what you expect, not a check") and offered no
 * mechanism. `StepOptions.schema` and `WaitForOptions.schema` are the mechanism;
 * this module is what runs them.
 *
 * ## Durable session state has been checked structurally for a long time
 *
 * That is the symmetry to lead with, because it settles whether this is worth
 * paying for. A `sessionSlot`'s value is checked in BOTH backends before it is
 * stored — `Map` → `{}`, `Date` → string, `NaN` → null: *the values that corrupt
 * do not throw, so `JSON.stringify` is not the check* (`packages/aai/CLAUDE.md`,
 * "A slot OWNS its session state"). A step's output goes through the journal's
 * own codec, is read back days later by a different process and possibly a
 * different bundle, and had no check of any kind. It is exactly as durable and
 * was strictly less defended.
 *
 * The codec is the other half of that story. `workflow-typed-json.ts` carries
 * envelopes for `Uint8Array`, `Date`, `Map` and `Set`, and its own doc names what
 * is left: *"this codec still has no unsupported-type GUARD, so any other exotic
 * value journals as `{}` — a structural check at the step boundary, not a fourth
 * envelope."* A schema at the step boundary is that check, and it is better than
 * the guard would have been: an author's schema knows what the step MEANS to
 * return, where a codec can only know what it can carry.
 *
 * ## A step is checked on BOTH sides, and the two catch different bugs
 *
 * - **WRITE**, before `journal.appendStep`. Catches the body producing the wrong
 *   shape — or one the codec would flatten — at the step that produced it,
 *   rather than on a replay days later where the evidence is a row in a database
 *   and the code that wrote it may not exist any more. What is journaled is the
 *   VALIDATED value, never the raw one: the journal is what the next walk reads,
 *   so a coercing schema that answered this walk must answer that one identically.
 * - **READ**, on the settled-entry path that used to be `entry.output as T`.
 *   Catches a REDEPLOY mid-flight — the run resumes against a bundle whose step
 *   returns a different shape, and the body is handed the old one under the new
 *   type. That is precisely the case `RunRecord.codeVersion` exists to NARRATE
 *   (`workflow-code-version.ts`), so the refusal reads it and says which of the
 *   two causes the record rules out.
 *
 * **And the two are CLASSIFIED differently, which is the load-bearing half.**
 *
 * A write-side failure is the step's OWN failure: the body produced a bad value,
 * so it travels the ordinary attempt path — an attempt is spent, the backoff
 * runs, and a retry may well produce a good value (a flaky provider answering a
 * field as `null` on one call is the shape). It is a plain error, so
 * `attemptLoop` treats it as retryable and journals `failed` only when the
 * budget is out, which is the normal contract.
 *
 * A read-side failure is NOT a step failure and must never be journaled as one.
 * The step SUCCEEDED — days ago, and its entry says so — and what has gone wrong
 * is a disagreement between the journal and the code now walking it. Journaling
 * `failed` over it would break the rule "An attempt is a LEASE, not a tally"
 * states in `packages/aai-runtime/CLAUDE.md` and this package pays for twice
 * already: **only a walk whose own body threw may write a `failed` entry.** So it
 * is a verdict about the WALK, in the family of a divergence and a
 * `StepAbandonedError` — a {@link FatalError} recorded through `replayRun`'s
 * `refused` channel, so a body that catches broadly cannot turn it into
 * `completed`, and no redelivery retries it.
 *
 * The write-side pass is also what makes that arm's classification safe: a value
 * this walk journaled has already satisfied the schema, so a read-side refusal
 * can only ever be about a value some OTHER walk (or bundle) wrote.
 *
 * ## A wait's payload is one boundary, not two
 *
 * There is no write side for a hook: the payload is written by a stranger over
 * public HTTP and the run is not walking when it lands. So the check happens
 * where the body is handed the value, and it is FATAL for the reason a retry
 * cannot help — the payload is journaled, so every later delivery reads the same
 * bytes and refuses identically. `workflow-replay-waits.ts` carries what that
 * means for the hook's own state.
 *
 * @module
 */

import type { StandardSchemaV1 } from "@alexkroman1/aai/host-internal";
import { formatSchemaIssues } from "@alexkroman1/aai/internal";
import { FatalError } from "@alexkroman1/aai/step-errors";
import { errorMessage } from "@alexkroman1/aai/utils";
import type { CodeChange } from "./workflow-code-version.ts";
import type { StepEntry } from "./workflow-journal-types.ts";

/** What {@link checkWorkflowValue} answers. */
export type SchemaCheck = { ok: true; value: unknown } | { ok: false; issues: string };

/**
 * Run one Standard Schema over one value.
 *
 * **A schema that THROWS is a failed check rather than an escaping error**, and
 * that is deliberate on both sides. `~standard.validate` is a vendor's code
 * reached from inside a workflow body, so a throw from it would unwind through
 * the body like any ordinary error — where a `catch` in the body could swallow it
 * and the run would report `completed` over a value nothing verified. Folding it
 * into the verdict keeps every outcome of "we asked the schema" on one channel.
 *
 * The value it answers is the schema's OUTPUT and never the input, so a coercing
 * schema's result is what the caller journals and hands on. See the module doc.
 *
 * @internal
 */
export async function checkWorkflowValue(
  schema: StandardSchemaV1,
  value: unknown,
): Promise<SchemaCheck> {
  try {
    const result = await schema["~standard"].validate(value);
    if (result.issues) return { ok: false, issues: formatSchemaIssues(result.issues) };
    return { ok: true, value: result.value };
  } catch (err: unknown) {
    return { ok: false, issues: `the schema itself threw: ${errorMessage(err)}` };
  }
}

/**
 * The WRITE-side failure: the body produced a value its own schema rejects.
 *
 * A plain `Error`, which is the whole classification — `attemptLoop` retries
 * anything that is not a {@link FatalError}, so this spends an attempt and gets
 * another. Thrown from inside the attempt's `try`, so nothing is journaled unless
 * the budget runs out, at which point it settles `failed` like any other step
 * that could not be made to work.
 *
 * @internal
 */
function stepOutputRejected(name: string, issues: string): Error {
  return new Error(
    `Step "${name}" produced a value its schema rejects: ${issues}. ` +
      "Nothing was journaled — the value a step returns is what every later " +
      "replay reads, so it is checked before it is stored rather than after. " +
      "Fix what the step returns, or widen the schema on ctx.step's options.",
  );
}

/**
 * The WRITE side, as one call: the value to journal, or a throw.
 *
 * Called from inside the attempt's `try` so the throw is an ordinary attempt
 * failure (see {@link stepOutputRejected}), and BEFORE `journal.appendStep`, so
 * a rejected value is never stored. What it answers is the SCHEMA's value, which
 * is what makes a coercing schema safe here: the journal then holds what this
 * walk handed the body, so the next walk reads the same thing rather than the
 * raw value coerced a second time.
 *
 * @internal
 */
export async function checkedStepOutput(
  schema: StandardSchemaV1 | undefined,
  name: string,
  output: unknown,
): Promise<unknown> {
  if (schema === undefined) return output;
  const check = await checkWorkflowValue(schema, output);
  if (!check.ok) throw stepOutputRejected(name, check.issues);
  return check.value;
}

/**
 * What the run record can say about a READ-side mismatch.
 *
 * The same three-state reading `workflow-replay-divergence.ts` makes and
 * deliberately not the same sentences: there a `same` verdict leaves a
 * non-deterministic BODY as the only cause, and here it leaves something else
 * entirely — the journal was written by this very bundle, so the schema has
 * simply never described what the step returns. Sharing the text would state the
 * wrong conclusion in the one case where the record actually settles something.
 */
function codeSentence(code: CodeChange): string {
  if (code.kind === "changed") {
    return (
      "\nThe run record settles which cause this is: this run STARTED against " +
      `bundle ${code.startedUnder} and is being walked by ${code.current}, so the ` +
      "code changed while it was in flight and this step's shape changed with it. " +
      "Drain in-flight runs before deploying a change to a workflow body, or let " +
      "them fail."
    );
  }
  if (code.kind === "same") {
    return (
      "\nThe run record RULES OUT a redeploy: this run started against bundle " +
      `${code.version} and is being walked by the same one. So the entry was ` +
      "written by this same code, and the schema has never described what the " +
      "step returns — check the schema against the step's own body."
    );
  }
  return (
    "\nThe run record cannot say whether the code moved — it carries no code " +
    "version (a run started before the field existed, or a server with no bundle " +
    "hash, such as `aai dev`)."
  );
}

/**
 * The READ-side refusal: the JOURNAL holds a value the schema rejects.
 *
 * A {@link FatalError}, and the caller records it through `replayRun`'s `refused`
 * channel before throwing it — the two halves of "a verdict about the walk"
 * (see the module doc). It names the key as well as the step, because the whole
 * point of this arm is that the reader has to go and look at a row somebody
 * else's process wrote.
 *
 * @internal
 */
function journaledOutputRefused(
  name: string,
  key: string,
  issues: string,
  code: CodeChange,
): FatalError {
  return new FatalError(
    `Workflow replay refused step "${name}": the value journaled for it as ${key} ` +
      `does not match the schema the body declares — ${issues}. That step SUCCEEDED, ` +
      "so this is a verdict about the journal rather than about the step: nothing " +
      "has been failed over it, nothing was re-run, and a redelivery would read the " +
      "same row and refuse again." +
      codeSentence(code),
  );
}

/** What {@link journaledStepOutput} needs to answer one settled step. */
export type JournaledOutputOptions = {
  /** The settled entry, whose `output` is the value in question. */
  entry: StepEntry;
  name: string;
  key: string;
  /** The schema the BODY declares now — the half that may have moved. */
  schema: StandardSchemaV1 | undefined;
  /** What the run record says about the code, for the refusal's own sentence. */
  code: CodeChange;
  /**
   * Record the refusal on the walk.
   *
   * A callback for the reason every other engine refusal takes one: the message
   * is also THROWN, and `replayRun` holds it so a body that catches broadly
   * cannot turn a verdict about the walk into a `completed`.
   */
  refuse: (message: string) => void;
};

/**
 * The READ side, as one call: the value to hand the body, or a refusal.
 *
 * Extracted rather than inlined into `ctx.step` because the arm is a decision
 * with two outcomes and a message, and that closure is already the one Biome
 * measures at the complexity ceiling — the same seam `runStepAttempts` was split
 * at. A step with no schema pays one comparison.
 *
 * @internal
 */
export async function journaledStepOutput(options: JournaledOutputOptions): Promise<unknown> {
  const { entry, name, key, schema, code, refuse } = options;
  if (schema === undefined) return entry.output;
  const check = await checkWorkflowValue(schema, entry.output);
  if (check.ok) return check.value;
  const refusal = journaledOutputRefused(name, key, check.issues, code);
  refuse(refusal.message);
  throw refusal;
}

/**
 * The refusal for a hook payload the schema rejects.
 *
 * Fatal for the reason the module doc gives — the payload is journaled, so no
 * redelivery can produce a different one — and it names the workflow as well as
 * the token because a token is derived from the run's own input and reads as
 * data rather than as a place in the source.
 *
 * @internal
 */
export function waitPayloadRefused(workflow: string, token: string, issues: string): FatalError {
  return new FatalError(
    `Workflow "${workflow}" refused the payload signalled to ctx.waitFor(${JSON.stringify(token)}): ` +
      `${issues}. A payload arrives over public HTTP and is journaled as it arrived, so ` +
      "every later delivery of this run reads the same value and refuses it the same " +
      "way — the run fails here rather than retrying. The wait's window is left as the " +
      "delivery found it: answered, not reopened. Fix what the sender sends, or widen " +
      "the schema on ctx.waitFor's options.",
  );
}
