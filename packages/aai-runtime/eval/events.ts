// Copyright 2026 the AAI authors. MIT license.
/**
 * Reading an agent's behaviour off the session event stream.
 *
 * Three questions an eval asks of a run — where one reply ends, what the agent
 * SAID, and which tools it called — answered from {@link SessionEvent}s and
 * nothing else. No log scraping, no provider internals, no reaching into the
 * transport: the questions this repo's guides ask of an agent ("did it call the
 * right tool with the right arguments", "did it call them in that order", "how
 * many `speech.started` against how many `reply.cancelled`") are all questions
 * about a list of typed events.
 *
 * These are READERS, not assertions. An eval writes its claims in whatever
 * runner it already has — `expect` in a vitest file, or the recording runner in
 * `aai-evals` for a case that must profile rather than bisect — and reads the
 * facts from here.
 *
 * **Every reader that takes a SCHEMA takes it because the alternative is a cast,
 * and a cast is silent exactly when the thing it describes changed shape** —
 * which is the regression an eval exists to catch. Tool arguments are produced
 * by the model, tool results and state frames cross the wire serialized, so all
 * three are `unknown` and `String(args.code ?? "")` turns an argument the model
 * renamed into `""`. Four of the eight readers here are SINGULAR/PLURAL pairs
 * (`toolResultIn`/`toolResultsIn`, `lastStateIn`/`statesIn`) and the asymmetry
 * between each pair is deliberate: the singular throws when there is nothing to
 * read, because for it that can only be a mistake, and the plural answers `[]`,
 * because "it never called this" is a claim a case makes.
 *
 * **Two exports here are DIAGNOSTICS rather than readers**
 * ({@link toolNames}, {@link describeToolCalls}), and they exist for the same
 * reason the readers throw with names: a legible failure is what makes a noisy
 * instrument usable. A reader that throws says what happened; an `expect` that
 * fails says only "expected undefined to be defined" unless the case hands it a
 * message, and every case in the corpus was hand-building one. `eval/turns.ts`
 * carries the per-TURN half.
 *
 * @module
 */

import { formatSchemaIssues, type StandardSchemaV1 } from "@alexkroman1/aai/host-internal";
import type { SessionEvent } from "@alexkroman1/aai/protocol";
import { omitUndefined } from "@alexkroman1/aai/utils";

/** One tool call, paired with its result when the stream carries one. */
export type EvalToolCall = {
  readonly toolCallId: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  /** The serialized result, or undefined when the call never completed. */
  readonly result?: string;
};

/**
 * The events that END a reply.
 *
 * Declared ONCE, because two things must agree by construction: they partition
 * a run into turns for anything reading {@link toolCallsIn} per reply, and they
 * are what `openEvalSession`'s `say()` waits for. The set used to be written out
 * in two files, and a third terminator added to one copy would make `say()`
 * return mid-reply while the assertions still thought the turn was open — which
 * reads as the agent misbehaving rather than as a harness bug.
 */
export const TURN_ENDS: ReadonlySet<SessionEvent["type"]> = new Set([
  "reply.completed",
  "reply.cancelled",
]);

/**
 * The committed agent replies in `events`, in order — what the caller was told.
 *
 * Committed rather than streamed: a delta is a draft, and a reply the pipeline
 * cancelled mid-sentence was never heard in full. Asserting on deltas is how an
 * eval comes to pass on text no caller received.
 */
export function saidIn(events: readonly SessionEvent[]): readonly string[] {
  return events.flatMap((e) => (e.type === "agent-transcript.committed" ? [e.text] : []));
}

/**
 * The tool calls in `events`, each paired with the result event that answered
 * it. A call with no result is a call that never completed — reported as such
 * rather than dropped, because "it called the tool and the tool never returned"
 * is a finding.
 */
export function toolCallsIn(events: readonly SessionEvent[]): readonly EvalToolCall[] {
  const results = new Map<string, string>();
  for (const event of events) {
    if (event.type === "tool.completed") results.set(event.toolCallId, event.result);
  }
  const calls: EvalToolCall[] = [];
  for (const event of events) {
    if (event.type !== "tool.called") continue;
    const result = results.get(event.toolCallId);
    calls.push({
      toolCallId: event.toolCallId,
      name: event.toolName,
      args: event.args,
      ...omitUndefined({ result }),
    });
  }
  return calls;
}

/**
 * The names of `calls`, in call order — what the agent reached for.
 *
 * Thirty `.map((c) => c.name)` sites across the eval corpus, one of which
 * (`plan-and-execute`) had wrapped it as a local `named()`. Mostly it feeds a
 * failure message ({@link describeToolCalls} is that, done properly), but about
 * six sites are the ASSERTION itself —
 * `expect(toolNames(turn.toolCalls)).toEqual(["add_pizza"])` — which is the
 * strongest claim about tool ORDER available, and the reason this is an export
 * of its own rather than folded into the diagnostic.
 *
 * Names only: a claim about what a tool was ASKED for goes through
 * {@link toolArgsIn} with a schema, because `args` is `unknown` on the wire and
 * reading a field off it by hand is how an argument the model renamed becomes
 * `""`.
 */
export function toolNames(calls: readonly EvalToolCall[]): readonly string[] {
  return calls.map((call) => call.name);
}

/**
 * `calls` as one line, for the message argument of a failing assertion.
 *
 * `expect(logged).toBeDefined()` failing prints "expected undefined to be
 * defined", which says nothing about a desk that talked through three turns
 * without ever logging the ticket — so every case in the corpus passed a
 * message, and three of them built this exact string from
 * `session.toolCalls()`. It is the harness's own job: the readers next door
 * throw with names precisely because a legible failure is what makes a noisy
 * instrument usable, and then each case hand-rolled the same sentence anyway.
 *
 * **A call list that is EMPTY reads as "called no tools", never as an empty
 * bracket.** That is the case the message exists for — the agent answered with
 * a question instead of acting — and `tools called: []` is one character away
 * from looking like the message got truncated.
 *
 * ```ts
 * import { describeToolCalls, type EvalSession } from "@alexkroman1/aai-runtime/eval";
 *
 * export function loggedTicket(session: EvalSession): void {
 *   const logged = session.toolCalls().find((call) => call.name === "log_ticket");
 *   // The message an `expect(logged, …)` would carry, and what a bare
 *   // `toBeDefined()` failure leaves out.
 *   if (logged === undefined) throw new Error(describeToolCalls(session.toolCalls()));
 * }
 * ```
 */
export function describeToolCalls(calls: readonly EvalToolCall[]): string {
  return calls.length === 0 ? "called no tools" : `called ${toolNames(calls).join(", ")}`;
}

/**
 * An event the AGENT named, via `ctx.send` — `{ event, data }` pairs, in order.
 *
 * Filtered by name when one is given. A nudge that must arrive ONCE is the shape
 * that wants this: "exactly one `wind_down` on the third pick, none on the
 * fourth" is a claim about this list and about nothing else.
 */
export function customEventsIn(
  events: readonly SessionEvent[],
  name?: string,
): readonly { readonly event: string; readonly data: unknown }[] {
  return events.flatMap((e) =>
    e.type === "custom.emitted" && (name === undefined || e.event === name)
      ? [{ event: e.event, data: e.data }]
      : [],
  );
}

/**
 * The LATEST state frame the agent pushed (`AgentDef.syncState`) — what the page
 * is showing.
 *
 * For a template with a projection this is the strongest assertion available:
 * not "the tool returned ok" but "the customer can see it". Three separate eval
 * files hand-rolled this filter plus a cast before it was published.
 *
 * **Pass the SCHEMA.** The frame is `unknown` on the wire, so the alternative is
 * a cast, and a cast is silent exactly when the projection changed shape
 * underneath the eval — which is the regression an eval exists to catch. With a
 * schema, a frame that stopped matching FAILS naming the field. The overload
 * without one is for a case that only asks whether anything was pushed.
 */
export function lastStateIn<T>(
  events: readonly SessionEvent[],
  schema: StandardSchemaV1<unknown, T>,
): T | undefined;
export function lastStateIn(events: readonly SessionEvent[]): unknown;
export function lastStateIn<T>(
  events: readonly SessionEvent[],
  schema?: StandardSchemaV1<unknown, T>,
): T | unknown {
  const frames = events.filter((e) => e.type === "state.updated");
  const last = frames.at(-1);
  if (last === undefined) return undefined;
  const state = last.state;
  if (schema === undefined) return state;
  const result = schema["~standard"].validate(state);
  if (result instanceof Promise) {
    throw new TypeError("lastStateIn needs a synchronous schema — this one validates async");
  }
  if (result.issues) {
    throw new Error(
      `the last state frame does not match the schema: ${formatSchemaIssues(result.issues)}`,
    );
  }
  return result.value;
}

/**
 * A tool result, parsed as JSON when it IS JSON and handed back raw when it is
 * not.
 *
 * `call.result` is a string on the wire and a tool is under no obligation to put
 * JSON in it — `run_code` prints whatever the snippet printed, so "Saturday" and
 * "3.106855" are ordinary results. Both readers used to call `JSON.parse`
 * unguarded, which turned one into
 * `SyntaxError: Unexpected token 'S', "Saturday" is not valid JSON` thrown from
 * inside this file, naming neither the tool, nor the case, nor the value. It
 * failed a real template eval whose own assertion was
 * `toolResultsIn(...).join("\n")` — a caller that had asked for no schema and
 * therefore wanted exactly that text.
 *
 * So: no schema means the caller will read whatever came back, and a string is
 * what came back. A SCHEMA is different — it is a declaration that the result
 * has a shape, so non-JSON there is a real mismatch and throws with the tool,
 * the position and the offending text in the message, which is what the bare
 * `SyntaxError` failed to say.
 */
function parseToolResult(raw: string, name: string, at: number, hasSchema: boolean): unknown {
  try {
    return JSON.parse(raw);
  } catch (cause) {
    if (!hasSchema) return raw;
    throw new Error(
      `the ${ordinal(at)} call to "${name}" answered text, not JSON, but a schema was ` +
        `supplied: ${JSON.stringify(raw.slice(0, 200))}`,
      { cause },
    );
  }
}

/**
 * The result of the ONE call to `name` in `calls`, parsed.
 *
 * `EvalToolCall.result` is the serialized string the model was handed, so every
 * eval that asserts on what a tool ANSWERED was parsing and indexing it by
 * hand — five files had written the same helper. What matters more than the
 * parse is the THROW: a `find` that misses answers `undefined`, and a case then
 * asserts against nothing and passes. This names what was called instead.
 */
export function toolResultIn<T = unknown>(
  calls: readonly EvalToolCall[],
  name: string,
  schema?: StandardSchemaV1<unknown, T>,
): T {
  const matching = calls.filter((call) => call.name === name);
  if (matching.length === 0) {
    const seen = calls.map((c) => c.name).join(", ");
    throw new Error(`no call to "${name}"; this scope called: ${seen || "no tools"}`);
  }
  if (matching.length > 1) {
    throw new Error(`${matching.length} calls to "${name}" — read them off toolCalls yourself`);
  }
  const call = matching[0];
  if (call?.result === undefined) throw new Error(`the call to "${name}" never completed`);
  const parsed = parseToolResult(call.result, name, 0, schema !== undefined);
  if (schema === undefined) return parsed as T;
  const result = schema["~standard"].validate(parsed);
  if (result instanceof Promise) {
    throw new TypeError("toolResultIn needs a synchronous schema — this one validates async");
  }
  if (result.issues) {
    throw new Error(
      `"${name}"'s result does not match the schema: ${formatSchemaIssues(result.issues)}`,
    );
  }
  return result.value;
}

/**
 * Every call to `name` in `calls`, with its ARGUMENTS — what the agent asked
 * for, in call order.
 *
 * The plural half of {@link toolResultIn}, and the one that was missing: nine
 * eval files wrote `calls.filter((c) => c.name === X).map((c) => c.args.…)` and
 * three of them wrapped it in a local `codeIn`/`fetchedUrls`/`drugsIn` reader —
 * twenty-two `.filter((c) => c.name === …)` sites across the corpus.
 *
 * **Pass the SCHEMA when the case reads a FIELD.** `args` is
 * `Record<string, unknown>` on the wire — the model produced it and nothing
 * validated it, since the tool executor is where a bad call is rejected — so the
 * alternative is `String(c.args.code ?? "")`, which turns an argument the model
 * renamed, or never sent, into `""`. That is a claim about the agent silently
 * becoming a claim about nothing: an eval asserting `codeIn(turn)` contains
 * `Math.PI` passes on an empty string only if the case ALSO asserted the call
 * happened, and three of them did not. With a schema, arguments that stopped
 * matching FAIL naming the field.
 *
 * ZERO calls answers `[]` rather than throwing, unlike {@link toolResultIn} —
 * "it never called this" is a claim the plural form is used to make
 * (`expect(toolArgsIn(calls, "run_code")).toHaveLength(0)`), where for the
 * singular it can only be a mistake.
 */
export function toolArgsIn<T>(
  calls: readonly EvalToolCall[],
  name: string,
  schema: StandardSchemaV1<unknown, T>,
): readonly T[];
export function toolArgsIn(
  calls: readonly EvalToolCall[],
  name: string,
): readonly Record<string, unknown>[];
export function toolArgsIn<T>(
  calls: readonly EvalToolCall[],
  name: string,
  schema?: StandardSchemaV1<unknown, T>,
): readonly (T | Record<string, unknown>)[] {
  return callsTo(calls, name).map((call, at) =>
    schema === undefined ? call.args : validate(schema, call.args, `"${name}" call ${at}'s args`),
  );
}

/**
 * Every call to `name` in `calls`, with its RESULT parsed — what each answered,
 * in call order.
 *
 * {@link toolResultIn} refuses more than one call on purpose: "the one call to
 * X" is the common claim and two of them is usually a finding. The plural is the
 * other half, and three eval files had written it as
 * `.map((c) => c.result ?? "")` — which turns "the tool never returned" into an
 * empty string, i.e. drops exactly the finding {@link toolResultIn} throws to
 * report. An incomplete call throws here too, naming its position.
 *
 * ZERO calls answers `[]`, for the reason {@link toolArgsIn} gives.
 */
export function toolResultsIn<T = unknown>(
  calls: readonly EvalToolCall[],
  name: string,
  schema?: StandardSchemaV1<unknown, T>,
): readonly T[] {
  return callsTo(calls, name).map((call, at) => {
    if (call.result === undefined) {
      throw new Error(`the ${ordinal(at)} call to "${name}" never completed`);
    }
    const parsed = parseToolResult(call.result, name, at, schema !== undefined);
    return schema === undefined
      ? (parsed as T)
      : validate(schema, parsed, `"${name}" result ${at}`);
  });
}

/**
 * Every state frame the agent pushed (`AgentDef.syncState`), oldest first —
 * what the page showed, in order.
 *
 * {@link lastStateIn} answers the newest, which is the right question for "can
 * the customer see it". The SEQUENCE is a different claim and a stronger one:
 * "the cart was never shown as placed before the tool ran", "no frame between
 * these two turns leaked the pending change". Three eval files hand-rolled it —
 * `events.flatMap((e) => (e.type === "state.updated" ? [Schema.parse(e.state)] : []))`
 * in three spellings, one of them a `for` loop — and every one of them reached
 * for the schema, which is the tell that a frame is `unknown` on the wire and
 * asserting on a cast is how a projection that changed shape stops being
 * noticed.
 *
 * A case wanting the frames only up to some point slices `events` first: this
 * reads whatever list it is given, which is why it takes events rather than a
 * session.
 */
export function statesIn<T>(
  events: readonly SessionEvent[],
  schema: StandardSchemaV1<unknown, T>,
): readonly T[];
export function statesIn(events: readonly SessionEvent[]): readonly unknown[];
export function statesIn<T>(
  events: readonly SessionEvent[],
  schema?: StandardSchemaV1<unknown, T>,
): readonly (T | unknown)[] {
  const frames = events.flatMap((e) => (e.type === "state.updated" ? [e.state] : []));
  return schema === undefined
    ? frames
    : frames.map((state, at) => validate(schema, state, `state frame ${at}`));
}

/** The calls to one tool, in call order. */
function callsTo(calls: readonly EvalToolCall[], name: string): readonly EvalToolCall[] {
  return calls.filter((call) => call.name === name);
}

/** `0` -> `"1st"`, for a message that has to say WHICH call. */
function ordinal(index: number): string {
  const n = index + 1;
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
}

/**
 * Validate one value against a Standard Schema, or throw naming `what`.
 *
 * Its own function because five readers here owe the identical three checks, and
 * the ASYNC one is the trap: a schema whose `validate` returns a promise would
 * otherwise be truthy-checked for `.issues`, find none, and pass every case.
 */
function validate<T>(schema: StandardSchemaV1<unknown, T>, value: unknown, what: string): T {
  const result = schema["~standard"].validate(value);
  if (result instanceof Promise) {
    throw new TypeError(`${what} needs a synchronous schema — this one validates async`);
  }
  if (result.issues) {
    throw new Error(`${what} does not match the schema: ${formatSchemaIssues(result.issues)}`);
  }
  return result.value;
}
