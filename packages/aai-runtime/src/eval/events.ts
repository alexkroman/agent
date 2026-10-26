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
 * **Every reader is TYPED by what it reads, because the alternative is a cast,
 * and a cast is silent exactly when the thing it describes changed shape** —
 * which is the regression an eval exists to catch. A tool reader takes the tool's
 * DEF — the file's default export, or a speaker's `tools` entry — and answers
 * the types that def's `execute` declares, the wire name read off the def
 * (`toolNameOf`); a state reader takes the slot's PROJECTION, or a slot name
 * and a schema, since a frame crosses the wire serialized and
 * `String(args.code ?? "")` turns a field the agent renamed into `""`. Four of
 * the eight readers here are SINGULAR/PLURAL pairs
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

// `StandardSchemaV1` from the SDK ROOT, where it is contracted, rather than
// `/host-internal`: these readers are published, and a non-semver import in their
// signatures hashed only the name.
import type {
  ClientEventMap,
  InferToolInput,
  InferToolOutput,
  SessionEvent,
  StandardSchemaV1,
  StateProjection,
  ToolDef,
  ToolInputSchema,
} from "@alexkroman1/aai";
import { formatSchemaIssues } from "@alexkroman1/aai/host-internal";
// The name an agent registered a def under: what lets every tool reader below
// take the DEF, typed, and still match the wire by name. Runner-free, like
// everything on that subpath, so `/eval` stays importable without vitest.
import { toolNameOf } from "@alexkroman1/aai/testing";
import { type INSTRUCTION_KEY, isRecord, omitUndefined } from "@alexkroman1/aai/utils";

/**
 * The result `D`'s `execute` declares, WITHOUT the `$instruction` key a
 * `withInstruction` result carries: the runtime strips it before the
 * `tool.completed` frame is recorded (`tools/result-instruction.ts`), so the
 * wire value a reader parses never has it, and a spec must not be able to
 * read a field that is not there. Distributes over a union, so a
 * `ToolFailure` arm and a plain (non-record) result come through untouched.
 *
 * @public
 */
export type EvalToolOutput<D extends ToolDef<ToolInputSchema>> =
  InferToolOutput<D> extends infer O
    ? O extends Record<string, unknown>
      ? Omit<O, typeof INSTRUCTION_KEY>
      : O
    : never;

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
 * a run into turns for anything reading {@link toolCallsInEvents} per reply, and they
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
  return events.flatMap((e) => (e.type === "agentTranscript.committed" ? [e.text] : []));
}

/**
 * Every `error.reported` in `events`, in order — what the RUNTIME reported, as
 * opposed to what the agent said or called. Typed as the narrowed member of
 * `SessionEvent` rather than under a name of its own, so a case names nothing
 * this subpath does not already publish.
 *
 * Three template evals wrote `events.some((e) => e.type === "error.reported")`
 * and asserted it `false`, which on failure prints "expected true to be false"
 * and nothing about WHICH error. This hands back the events themselves, so
 * `expect(errorsIn(events)).toEqual([])` prints the code and the message.
 *
 * `EvalTurn.errors` is this over one turn. Note what a turn's list can hold:
 * `openEvalSession` REFUSES a turn the pipeline failed (`_turn-faults.ts`), so a
 * turn a case gets to read carries only `code: "tool"` errors — a tool that
 * threw, whose failure went back to the model. Over `session.events()` the list
 * is unfiltered.
 */
export function errorsIn(
  events: readonly SessionEvent[],
): readonly SessionEvent<"error.reported">[] {
  return events.filter((e): e is SessionEvent<"error.reported"> => e.type === "error.reported");
}

/**
 * The tool calls in `events`, each paired with the result event that answered
 * it. A call with no result is a call that never completed — reported as such
 * rather than dropped, because "it called the tool and the tool never returned"
 * is a finding.
 */
export function toolCallsInEvents(events: readonly SessionEvent[]): readonly EvalToolCall[] {
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
 * (`research-planner-agent`) had wrapped it as a local `named()`. Mostly it feeds a
 * failure message ({@link describeToolCalls} is that, done properly), but about
 * six sites are the ASSERTION itself —
 * `expect(toolNames(turn.toolCalls)).toEqual(["add_pizza"])` — which is the
 * strongest claim about tool ORDER available, and the reason this is an export
 * of its own rather than folded into the diagnostic.
 *
 * Names only: a claim about what a tool was ASKED for goes through
 * {@link toolArgsIn} with the tool's def, because `args` is `unknown` on the
 * wire and reading a field off it by hand is how an argument the model renamed
 * becomes `""`.
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
 * **And a call that NEVER COMPLETED says so, right beside its name.** That is
 * the state {@link EvalToolCall.result} spells as `undefined`, and the state
 * every message built by hand rendered identically to a call that answered:
 * `called note_it` while the tool body had not run and `toolCalls[0].result`
 * was `undefined`, which a case then meets as a chai type error four lines
 * further on. `openEvalSession` refuses such a turn outright — this is what the
 * DIAGNOSTIC owes the cases that read a call list some other way (a cancelled
 * reply, `toolCallsInTurns` over several turns).
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
  if (calls.length === 0) return "called no tools";
  const named = calls.map((call) =>
    call.result === undefined ? `${call.name} (never completed)` : call.name,
  );
  return `called ${named.join(", ")}`;
}

/**
 * An event the AGENT named, via `ctx.send` — `{ event, data }` pairs, in order.
 *
 * Filtered by name when one is given. A nudge that must arrive ONCE is the shape
 * that wants this: "exactly one `wind_down` on the third pick, none on the
 * fourth" is a claim about this list and about nothing else.
 *
 * **Typed by `ClientEventMap` when the agent declared the name there**: an
 * augmented map types `data` as the declared payload, so a case reads a field
 * off it with no cast. A name nobody declared still answers `unknown`.
 */
export function customEventsIn<K extends keyof ClientEventMap & string>(
  events: readonly SessionEvent[],
  name: K,
): readonly { readonly event: K; readonly data: ClientEventMap[K] }[];
export function customEventsIn(
  events: readonly SessionEvent[],
  name?: string,
): readonly { readonly event: string; readonly data: unknown }[];
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
 * is showing — or one SLOT's value in it. The frame is keyed by slot name, so a
 * case names its slot exactly as the page does (`useAgentState(slot.projected)`
 * reads `state[slot]`): not "the tool returned ok" but "the customer can see it".
 *
 * **Pass the SCHEMA.** A frame is JSON off the wire, and a cast is silent exactly
 * when the projection changed shape underneath the eval; with a schema, a value
 * that stopped matching FAILS naming the field. Without a slot: the whole frame.
 *
 * **Or pass the PROJECTION** — `slot.projected`, the very object
 * `agent({ syncState })` and the page's `useAgentState` take. It carries the
 * slot key, so the case names nothing the agent does not, and its result type,
 * so the frame comes back as the page's `V`. It is checked STRUCTURALLY
 * against what the projection renders for the default (`projected()`): a
 * frame whose keys differ — a field the view gained or lost since the eval
 * was written — fails naming them, which is the drift a cast would hide.
 */
export function lastStateIn<V>(
  events: readonly SessionEvent[],
  projection: StateProjection<V>,
): V | undefined;
export function lastStateIn<T>(
  events: readonly SessionEvent[],
  slot: string,
  schema: StandardSchemaV1<unknown, T>,
): T | undefined;
export function lastStateIn(events: readonly SessionEvent[], slot: string): unknown;
export function lastStateIn(
  events: readonly SessionEvent[],
): Readonly<Record<string, unknown>> | undefined;
export function lastStateIn<T>(
  events: readonly SessionEvent[],
  slot?: string | StateProjection<T>,
  schema?: StandardSchemaV1<unknown, T>,
): T | unknown {
  const frames = events.filter((e) => e.type === "state.updated");
  const last = frames.at(-1);
  if (last === undefined) return undefined;
  if (slot === undefined) return last.state;
  if (typeof slot === "function") {
    return projected(slot, last.state[slot.key], "the last state frame");
  }
  const value = last.state[slot];
  if (schema === undefined) return value;
  return validate(schema, value, `the last state frame's "${slot}"`);
}

/**
 * A tool result, parsed as JSON when it IS JSON and handed back raw when it is
 * not.
 *
 * `call.result` is a string on the wire and a tool is under no obligation to put
 * JSON in it — a tool whose `execute` answers a string is serialized as that
 * string, and `run_code` prints whatever the snippet printed, so "Saturday" and
 * "3.106855" are ordinary results. Both readers used to call `JSON.parse`
 * unguarded, which turned one into
 * `SyntaxError: Unexpected token 'S', "Saturday" is not valid JSON` thrown from
 * inside this file, naming neither the tool, nor the case, nor the value. It
 * failed a real template eval whose own assertion was
 * `toolResultsIn(...).join("\n")` — a caller that wanted exactly that text.
 */
function parseToolResult(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Every call to `name` in `calls` — THROWING, naming what the scope did call,
 * when there is none. The two result readers below share it so a miss has one
 * spelling: a `find` that answers `undefined` is how a case passes against
 * nothing.
 */
function requireCallsTo(calls: readonly EvalToolCall[], name: string): readonly EvalToolCall[] {
  const matching = callsTo(calls, name);
  if (matching.length === 0) {
    const seen = calls.map((c) => c.name).join(", ");
    throw new Error(`no call to "${name}"; this scope called: ${seen || "no tools"}`);
  }
  return matching;
}

/**
 * The result of the LAST call to `tool` in `calls`, parsed and typed by the def.
 *
 * One of three result readers, told apart by how many calls the claim allows:
 * {@link toolResultIn} — EXACTLY one (zero or two throw); this — at least one,
 * the settled last; {@link toolResultsIn} — every call, in order (zero is `[]`).
 *
 * {@link toolResultIn} refuses a scope holding two calls to one tool, and that
 * refusal is right for a single TURN: two calls there is usually the finding.
 * Across turns it is ordinary — a caller nudges, the agent re-reads the state,
 * and a case reading `toolCallsInTurns(turns)` meets a duplicate through no
 * fault of the agent's — and a live model calls a median of one tool per reply
 * (`DEFAULT_MAX_STEPS`), so the claims that survive it are read across turns.
 *
 * The LAST rather than the first, because a repeated call is the agent settling
 * on an answer and the settled one is what the caller was told.
 *
 * ```ts
 * // file: tools/game_state_score.ts
 * import { tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * export default tool({
 *   description: "Award points",
 *   inputSchema: z.object({ points: z.number() }),
 *   execute: ({ points }) => ({ score: points }),
 * });
 *
 * // file: agent.eval.test.ts
 * import {
 *   type EvalTurn,
 *   lastToolResultIn,
 *   toolCallsInTurns,
 * } from "@alexkroman1/aai-runtime/eval";
 * import gameStateScore from "./tools/game_state_score.ts";
 *
 * export function finalScore(turns: readonly EvalTurn[]): number {
 *   const calls = toolCallsInTurns(turns);
 *   // The score as it finally stood, even if the narrator awarded twice.
 *   return lastToolResultIn(calls, gameStateScore).score;
 * }
 * ```
 */
export function lastToolResultIn<D extends ToolDef<ToolInputSchema>>(
  calls: readonly EvalToolCall[],
  tool: D,
): EvalToolOutput<D> {
  const matching = requireCallsTo(calls, toolNameOf(tool));
  // Hand the single last call to the reader that already parses one, so the
  // parse and the never-completed check have one spelling.
  return toolResultIn([matching.at(-1) as EvalToolCall], tool);
}

/**
 * The result of the ONE call to `tool` in `calls`, parsed and typed by the def
 * — zero calls or two throw. {@link lastToolResultIn} allows repeats;
 * {@link toolResultsIn} reads them all.
 *
 * `EvalToolCall.result` is the serialized string the model was handed, so every
 * eval that asserts on what a tool ANSWERED was parsing and indexing it by
 * hand — five files had written the same helper. What matters more than the
 * parse is the THROW: a `find` that misses answers `undefined`, and a case then
 * asserts against nothing and passes. This names what was called instead.
 *
 * **The tool is its DEF** — a `tools/` file's default export, or a speaker's
 * `tools` entry for a roster tool — and the result is TYPED by it:
 * `InferToolOutput<typeof placeOrder>`, the type its `execute` declares, minus
 * the `$instruction` key a `withInstruction` result carries (the runtime strips
 * it before the frame is recorded, so the wire value never has it). The wire
 * name is read off the def (`toolNameOf`), so a renamed file fails here by
 * name. For a `dialog.tool` the envelope type is known
 * (`DialogToolResult<R> | ToolFailure`), and `expectToolOk` unwraps it. A
 * refusal the GATE answered (a roster entry off the line) parses as the
 * `ToolFailure` arm, which `isToolFailure` narrows.
 */
export function toolResultIn<D extends ToolDef<ToolInputSchema>>(
  calls: readonly EvalToolCall[],
  tool: D,
): EvalToolOutput<D> {
  const name = toolNameOf(tool);
  const matching = requireCallsTo(calls, name);
  if (matching.length > 1) {
    throw new Error(`${matching.length} calls to "${name}" — read them off toolCalls yourself`);
  }
  const call = matching[0];
  if (call?.result === undefined) throw new Error(`the call to "${name}" never completed`);
  return parseToolResult(call.result) as EvalToolOutput<D>;
}

/**
 * Every call to `tool` in `calls`, with its ARGUMENTS — what the agent asked
 * for, in call order, typed by the def's `inputSchema`.
 *
 * The plural half of {@link toolResultIn}, and the one that was missing: nine
 * eval files wrote `calls.filter((c) => c.name === X).map((c) => c.args.…)` and
 * three of them wrapped it in a local `codeIn`/`fetchedUrls`/`drugsIn` reader —
 * twenty-two `.filter((c) => c.name === …)` sites across the corpus.
 *
 * `args` is `Record<string, unknown>` on the wire — the model produced it, and
 * the tool executor validated it against `inputSchema` before `execute` ran —
 * so the def's input type is what each call carried, and a case reads a field
 * off it with no cast. The alternative, `String(c.args.code ?? "")`, turns an
 * argument the model renamed, or never sent, into `""`: a claim about the
 * agent silently becoming a claim about nothing.
 *
 * ZERO calls answers `[]` rather than throwing, unlike {@link toolResultIn} —
 * "it never called this" is a claim the plural form is used to make
 * (`expect(toolArgsIn(calls, runCode)).toHaveLength(0)`), where for the
 * singular it can only be a mistake.
 */
export function toolArgsIn<D extends ToolDef<ToolInputSchema>>(
  calls: readonly EvalToolCall[],
  tool: D,
): readonly InferToolInput<D>[] {
  return callsTo(calls, toolNameOf(tool)).map((call) => call.args as InferToolInput<D>);
}

/**
 * {@link toolArgsIn} by NAME and schema — for the BUILTIN readers next door
 * (`run-code.ts`), and nothing else. A builtin has no def a case could import,
 * so the reader that owns its name reads it by that name, and proves the shape
 * through a schema since no def types it. Not on the barrel: a case names a
 * tool by its def.
 */
export function builtinToolArgsIn<T>(
  calls: readonly EvalToolCall[],
  name: string,
  schema: StandardSchemaV1<unknown, T>,
): readonly T[] {
  return callsTo(calls, name).map((call, at) =>
    validate(schema, call.args, `"${name}" call ${at}'s args`),
  );
}

/**
 * Every call to `tool` in `calls`, with its RESULT parsed and typed by the def
 * — what each answered, in call order. The plural of {@link toolResultIn}
 * (exactly one) and {@link lastToolResultIn} (the last of several).
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
export function toolResultsIn<D extends ToolDef<ToolInputSchema>>(
  calls: readonly EvalToolCall[],
  tool: D,
): readonly EvalToolOutput<D>[] {
  const name = toolNameOf(tool);
  return callsTo(calls, name).map((call, at) => {
    if (call.result === undefined) {
      throw new Error(`the ${ordinal(at)} call to "${name}" never completed`);
    }
    return parseToolResult(call.result) as EvalToolOutput<D>;
  });
}

/**
 * Every state frame the agent pushed (`AgentDef.syncState`), oldest first — or
 * one SLOT's value in each. The SEQUENCE is a stronger claim than
 * {@link lastStateIn}'s: "the cart was never shown as placed before the tool
 * ran". Pass the schema for its reason, or the PROJECTION for
 * {@link lastStateIn}'s. A case wanting the frames only up to some point
 * slices `events` first, which is why this takes events.
 */
export function statesIn<V>(
  events: readonly SessionEvent[],
  projection: StateProjection<V>,
): readonly V[];
export function statesIn<T>(
  events: readonly SessionEvent[],
  slot: string,
  schema: StandardSchemaV1<unknown, T>,
): readonly T[];
export function statesIn(events: readonly SessionEvent[], slot: string): readonly unknown[];
export function statesIn(
  events: readonly SessionEvent[],
): readonly Readonly<Record<string, unknown>>[];
export function statesIn<T>(
  events: readonly SessionEvent[],
  slot?: string | StateProjection<T>,
  schema?: StandardSchemaV1<unknown, T>,
): readonly (T | unknown)[] {
  const frames = events.flatMap((e) => (e.type === "state.updated" ? [e.state] : []));
  if (slot === undefined) return frames;
  if (typeof slot === "function") {
    return frames.map((frame, at) => projected(slot, frame[slot.key], `state frame ${at}`));
  }
  const values = frames.map((frame) => frame[slot]);
  return schema === undefined
    ? values
    : values.map((value, at) => validate(schema, value, `state frame ${at}'s "${slot}"`));
}

/** The calls to one tool, in call order. */
function callsTo(calls: readonly EvalToolCall[], name: string): readonly EvalToolCall[] {
  return calls.filter((call) => call.name === name);
}

/**
 * `0` -> `"1st"`, for a message that has to say WHICH call. Shared with the
 * `run_code` readers next door, so two messages about the same list spell a
 * position the same way; not on the barrel.
 */
export function ordinal(index: number): string {
  const n = index + 1;
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
}

/**
 * One slot's value in a frame, checked STRUCTURALLY against what the projection
 * renders for the default — or a throw naming the keys that differ.
 *
 * The frame already IS the projected value (the server pushed `projected(stored)`),
 * so the check is of the shape rather than a second projection: the frame's
 * keys must be the default's, a key whose default is `undefined` excepted
 * (JSON drops it). A projection to a primitive is checked by type. This is
 * what makes the def-typed read honest where a cast would not be: a view that
 * gained or lost a field since the eval was written fails by field name.
 */
function projected<V>(projection: StateProjection<V>, value: unknown, what: string): V {
  const expected: unknown = projection();
  const where = `${what}'s "${projection.key}"`;
  if (isRecord(expected)) {
    if (!isRecord(value)) {
      throw new Error(
        `${where} is ${describeFrameValue(value)}, and the projection renders an object with ` +
          `keys ${Object.keys(expected).join(", ") || "(none)"}`,
      );
    }
    const missing = Object.keys(expected).filter((k) => !(k in value) && expected[k] !== undefined);
    const extra = Object.keys(value).filter((k) => !(k in expected));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `${where} does not match the projection: ` +
          [
            missing.length > 0 ? `missing ${missing.join(", ")}` : "",
            extra.length > 0 ? `unexpected ${extra.join(", ")}` : "",
          ]
            .filter(Boolean)
            .join("; "),
      );
    }
  } else if (typeof value !== typeof expected || Array.isArray(value) !== Array.isArray(expected)) {
    throw new Error(
      `${where} is ${describeFrameValue(value)}, and the projection renders ${describeFrameValue(expected)}`,
    );
  }
  return value as V;
}

/** A frame value's kind, for a message — never the whole value. */
function describeFrameValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (isRecord(value)) return `an object with keys ${Object.keys(value).join(", ") || "(none)"}`;
  return `a ${typeof value}`;
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
