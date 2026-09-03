// Copyright 2026 the AAI authors. MIT license.
/**
 * The behaviour assertion vocabulary, over the typed session event stream.
 *
 * Every assertion here reads {@link SessionEvent}s and nothing else — no log
 * scraping, no provider internals, no reaching into the transport. That is what
 * the event stream bought: the questions this repo's guides ask of an agent
 * ("did it call the right tool with the right arguments", "did it call them in
 * that order", "how many `speech.started` against how many `reply.cancelled`")
 * are all questions about a list of typed events, and they used to be answerable
 * only from an external harness's stdout.
 *
 * ## Scoped, because "on that turn" is most of the meaning
 *
 * `t.calledTool("get_weather", { count: 1 })` over a whole call is a much weaker
 * claim than the same thing about ONE reply. {@link EvalScope.turn} returns a
 * scope over a single reply's events, so the strong form needs no hand-filtering
 * of a log. Scopes record into the same recorder and carry their own label
 * prefix, so a failure names the turn.
 *
 * ## Recorded, never thrown
 *
 * Every method here calls `recorder.check` and returns void. See `runner.ts`.
 *
 * @module
 */

import type { SessionEvent } from "@alexkroman1/aai/protocol";
import { errorMessage, isRecord } from "@alexkroman1/aai/utils";
// The event READERS and the terminator set are published, because the harness
// that produces the events is: `openEvalSession` waits on `TURN_ENDS` to decide
// a reply has ended, and these assertions use the same set to partition a run
// into turns. Two copies must agree by construction — a third terminator added
// to one would make `say()` return mid-reply while these still thought the turn
// was open, which reads as the agent misbehaving rather than as a harness bug.
import { type EvalToolCall, saidIn, TURN_ENDS, toolCallsIn } from "@alexkroman1/aai-runtime/eval";
import type { EvalRecorder } from "./runner.ts";

// Re-exported from the SOURCE rather than import-then-export: a scope's
// `toolCalls` is typed with it, so a reader of this vocabulary needs the name.
export type { EvalToolCall } from "@alexkroman1/aai-runtime/eval";

/** What {@link EvalScope.calledTool} may claim beyond the name. */
export type CalledToolOptions = {
  /**
   * A PARTIAL match against the recorded arguments: every key given must be
   * present and deep-equal. Partial because a voice agent's tool arguments carry
   * fields the case does not care about, and an exhaustive literal would make
   * every assertion break when a schema gains an optional field.
   */
  readonly args?: Record<string, unknown>;
  /** A substring the serialized result must contain. */
  readonly result?: string;
  /** Exactly this many calls to the tool, in this scope. */
  readonly count?: number;
};

/** Bounds for {@link EvalScope.event}. */
export type EventCountOptions = {
  readonly count?: number;
  readonly min?: number;
  readonly max?: number;
};

/** The vocabulary, over one scope's events. */
export type EvalScope = {
  /** The events this scope covers, in stream order. */
  readonly events: readonly SessionEvent[];
  /** The tool calls this scope covers, in call order. */
  readonly toolCalls: readonly EvalToolCall[];
  /** Committed agent replies in this scope — what the caller was told. */
  readonly said: readonly string[];

  /** A reply completed on its own terms, and no fatal error was reported. */
  succeeded(): void;
  /** The tool was called, optionally with these arguments / result / count. */
  calledTool(name: string, opts?: CalledToolOptions): void;
  /** The tool was never called. */
  notCalledTool(name: string): void;
  /** These tools were called in this relative order (a SUBSEQUENCE). */
  toolOrder(names: readonly string[]): void;
  /** No tool was called at all. */
  usedNoTools(): void;
  /** At most `n` tool calls. */
  maxToolCalls(n: number): void;
  /** A committed reply contains this text (case-insensitive) or matches it. */
  saidSomething(token: string | RegExp): void;
  /** No committed reply contains this text. */
  saidNothingAbout(token: string | RegExp): void;
  /** No `error.reported` at all. */
  noErrors(): void;
  /** This event type occurred, within these bounds. */
  event(type: SessionEvent["type"], opts?: EventCountOptions): void;
  /** This event type never occurred. */
  notEvent(type: SessionEvent["type"]): void;
  /** These event types occurred in this relative order (a SUBSEQUENCE). */
  eventOrder(types: readonly SessionEvent["type"][]): void;
  /** Anything else: the predicate reads the scope's whole event list. */
  eventsSatisfy(label: string, predicate: (events: readonly SessionEvent[]) => boolean): void;
  /** A scope over one reply's events. `index` is 0-based; out of range FAILS. */
  turn(index: number): EvalScope;
  /** How many replies this scope contains — turn indices are `0..turns()-1`. */
  turns(): number;
};

/**
 * Split a scope into per-reply slices.
 *
 * Everything up to and including a terminator belongs to that reply, which puts
 * the user turn that PROVOKED the reply in the same slice — deliberately, since
 * `turn(0).calledTool(…)` reads as "on the turn where the caller said X" and the
 * utterance is part of that claim. A trailing tail with no terminator is not a
 * turn: it is a reply still in flight, and asserting about one is a race.
 */
function turnsOf(events: readonly SessionEvent[]): SessionEvent[][] {
  const turns: SessionEvent[][] = [];
  let current: SessionEvent[] = [];
  for (const event of events) {
    current.push(event);
    if (TURN_ENDS.has(event.type)) {
      turns.push(current);
      current = [];
    }
  }
  return turns;
}

/** Deep PARTIAL match: every key of `expected` present and equal in `actual`. */
function matchesPartial(actual: unknown, expected: unknown): boolean {
  // Not `isRecord`, deliberately: this branch must let an ARRAY through to the
  // one below it, and `isRecord` excludes arrays. It is the "any non-null
  // object, arrays included" case `guard-invariants` rule 17's remedy says to
  // write out and baseline.
  if (expected === null || typeof expected !== "object") return actual === expected;
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, i) => matchesPartial(actual[i], item))
    );
  }
  if (!isRecord(actual)) return false;
  const seen = actual;
  return Object.entries(expected as Record<string, unknown>).every(
    ([key, value]) => key in seen && matchesPartial(seen[key], value),
  );
}

/** Is `wanted` a subsequence of `seen`? */
function isSubsequence(seen: readonly string[], wanted: readonly string[]): boolean {
  let at = 0;
  for (const name of seen) {
    if (name === wanted[at]) at += 1;
    if (at === wanted.length) return true;
  }
  return wanted.length === 0;
}

/** How many entries of `list` are `value` — the three counting assertions' shape. */
function countOf<T>(list: readonly T[], value: T): number {
  return list.filter((seen) => seen === value).length;
}

function matchesToken(text: string, token: string | RegExp): boolean {
  return typeof token === "string"
    ? text.toLowerCase().includes(token.toLowerCase())
    : token.test(text);
}

function short(value: unknown, max = 160): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text ?? String(value)).slice(0, max);
}

/**
 * A scope that FAILS every assertion made on it, with the same reason each time.
 *
 * The one caller is {@link EvalScope.turn} out of range, and the shape exists
 * because the obvious alternative — an empty scope — is silently WRONG. Half the
 * vocabulary is negative (`noErrors`, `notEvent`, `notCalledTool`,
 * `usedNoTools`, `maxToolCalls`, `saidNothingAbout`) and every one of those
 * holds vacuously over no events, so a case asserting three things about a turn
 * that never happened scored 75% and read as a mostly-correct agent.
 *
 * "Nothing was measured" is not "nothing was wrong". Each recorded label keeps
 * the assertion's own name, so a report still says WHICH claims were on a turn
 * that did not exist rather than collapsing them into one line.
 */
function failedScope(recorder: EvalRecorder, prefix: string, reason: string): EvalScope {
  const fail = (label: string): void => {
    recorder.check(false, `${prefix}${label}`, reason);
  };
  return {
    events: [],
    toolCalls: [],
    said: [],
    succeeded: () => fail("succeeded"),
    calledTool: (name) => fail(`calledTool(${name})`),
    notCalledTool: (name) => fail(`notCalledTool(${name})`),
    toolOrder: (names) => fail(`toolOrder(${names.join(" → ")})`),
    usedNoTools: () => fail("usedNoTools"),
    maxToolCalls: (n) => fail(`maxToolCalls(${n})`),
    saidSomething: (token) => fail(`saidSomething(${String(token)})`),
    saidNothingAbout: (token) => fail(`saidNothingAbout(${String(token)})`),
    noErrors: () => fail("noErrors"),
    event: (type) => fail(`event(${type})`),
    notEvent: (type) => fail(`notEvent(${type})`),
    eventOrder: (types) => fail(`eventOrder(${types.join(" → ")})`),
    eventsSatisfy: (label) => fail(label),
    // A turn OF a turn that does not exist does not exist either, and the
    // reason travels with it.
    turn: (index) => failedScope(recorder, `${prefix}turn ${index}: `, reason),
    turns: () => 0,
  };
}

/**
 * Build a scope over `events`, recording into `recorder`.
 *
 * `prefix` names the scope in every label it records (`""` for the whole run,
 * `"turn 1: "` for a reply), which is what makes a report readable without a
 * separate structure: the labels ARE the tree.
 */
export function eventScope(
  recorder: EvalRecorder,
  events: readonly SessionEvent[],
  prefix = "",
): EvalScope {
  const calls = toolCallsIn(events);
  const names = calls.map((c) => c.name);
  const types = events.map((e) => e.type);
  // Partitioned ONCE, beside the other derived views: `turn()` and `turns()` each
  // re-ran `turnsOf` per call, so a case that scopes three turns walked the event
  // list four times — and, more to the point, the two reads could disagree with
  // `types`/`said`/`calls`, which are snapshots taken here.
  const slices = turnsOf(events);
  const said = saidIn(events);
  const check = (ok: boolean, label: string, detail?: string): void => {
    recorder.check(ok, `${prefix}${label}`, detail);
  };

  return {
    events,
    toolCalls: calls,
    said,

    succeeded() {
      const completed = types.includes("reply.completed");
      // `flatMap`, not `find`: a `find` predicate does not NARROW its result, so
      // the detail below had to re-check `type === "error.reported"` twice to
      // reach `code` and `message` — the same union member, established three
      // times. Same shape as `noErrors` and `said` in this file.
      const fatal = events.flatMap((e) =>
        e.type === "error.reported" && e.fatal !== false ? [e] : [],
      )[0];
      check(
        completed && fatal === undefined,
        "succeeded",
        fatal === undefined
          ? `no reply.completed; saw ${types.join(", ") || "no events"}`
          : `fatal ${fatal.code}: ${short(fatal.message)}`,
      );
    },

    calledTool(name, opts = {}) {
      const matching = calls.filter((c) => c.name === name);
      if (matching.length === 0) {
        check(false, `calledTool(${name})`, `called: ${names.join(", ") || "no tools"}`);
        return;
      }
      check(true, `calledTool(${name})`);
      if (opts.count !== undefined) {
        check(
          matching.length === opts.count,
          `calledTool(${name}) count=${opts.count}`,
          `called ${matching.length}x`,
        );
      }
      if (opts.args !== undefined) {
        const wanted = opts.args;
        const hit = matching.find((c) => matchesPartial(c.args, wanted));
        check(
          hit !== undefined,
          `calledTool(${name}) args ${short(wanted, 80)}`,
          `saw ${matching.map((c) => short(c.args, 80)).join(" | ")}`,
        );
      }
      if (opts.result !== undefined) {
        const wanted = opts.result;
        const hit = matching.find((c) => c.result?.includes(wanted) === true);
        check(
          hit !== undefined,
          `calledTool(${name}) result ~ ${short(wanted, 60)}`,
          `saw ${matching.map((c) => short(c.result ?? "(no result)", 80)).join(" | ")}`,
        );
      }
    },

    notCalledTool(name) {
      const n = countOf(names, name);
      check(n === 0, `notCalledTool(${name})`, `called ${n}x`);
    },

    toolOrder(wanted) {
      check(
        isSubsequence(names, wanted),
        `toolOrder(${wanted.join(" → ")})`,
        `called: ${names.join(" → ") || "no tools"}`,
      );
    },

    usedNoTools() {
      check(calls.length === 0, "usedNoTools", `called: ${names.join(", ")}`);
    },

    maxToolCalls(n) {
      check(calls.length <= n, `maxToolCalls(${n})`, `made ${calls.length}: ${names.join(", ")}`);
    },

    saidSomething(token) {
      check(
        said.some((text) => matchesToken(text, token)),
        `saidSomething(${String(token)})`,
        `said: ${said.map((t) => short(t, 120)).join(" | ") || "nothing"}`,
      );
    },

    saidNothingAbout(token) {
      const hit = said.filter((text) => matchesToken(text, token));
      check(hit.length === 0, `saidNothingAbout(${String(token)})`, `said: ${short(hit[0] ?? "")}`);
    },

    noErrors() {
      const errors = events.flatMap((e) =>
        e.type === "error.reported" ? [`${e.code}: ${short(e.message, 100)}`] : [],
      );
      check(errors.length === 0, "noErrors", errors.join(" | "));
    },

    event(type, opts = {}) {
      const n = countOf(types, type);
      const wanted = opts.count;
      const min = wanted ?? opts.min ?? 1;
      const max = wanted ?? opts.max ?? Number.POSITIVE_INFINITY;
      // Spelled out rather than assembled by trimming a template: the previous
      // form leaned on a leading space inside the `<=` branch plus a `.trim()`,
      // so the separator lived in one branch and the fix-up in neither.
      const bounds: string[] = [];
      if (opts.min !== undefined) bounds.push(`>=${opts.min}`);
      if (opts.max !== undefined) bounds.push(`<=${opts.max}`);
      const bound = wanted === undefined ? bounds.join(" ") : `=${wanted}`;
      check(n >= min && n <= max, `event(${type}${bound === "" ? "" : ` ${bound}`})`, `saw ${n}`);
    },

    notEvent(type) {
      const n = countOf(types, type);
      check(n === 0, `notEvent(${type})`, `saw ${n}`);
    },

    eventOrder(wanted) {
      check(
        isSubsequence(types, wanted),
        `eventOrder(${wanted.join(" → ")})`,
        `saw: ${types.join(" → ") || "no events"}`,
      );
    },

    eventsSatisfy(label, predicate) {
      let ok = false;
      let detail: string | undefined;
      try {
        ok = predicate(events);
      } catch (err) {
        detail = `predicate threw: ${errorMessage(err)}`;
      }
      check(ok, label, detail ?? `over ${events.length} event(s)`);
    },

    turn(index) {
      const slice = slices[index];
      if (slice === undefined) {
        // An out-of-range turn returns a scope that FAILS every assertion made
        // on it, not an empty one.
        //
        // An empty scope satisfies every NEGATIVE claim vacuously — `noErrors`,
        // `notEvent`, `notCalledTool`, `usedNoTools`, `maxToolCalls`,
        // `saidNothingAbout` all hold over no events — so the old behaviour
        // recorded ONE failure and then silently passed the rest. A three-call
        // chain on a nonexistent turn scored 75%, and the package guide's claim
        // that out of range "FAILS rather than silently asserting nothing" was
        // true of the first call only. Failing everything is the honest reading:
        // nothing was measured, so nothing held.
        //
        // The `turn(N)` record itself stays, so a bare `scope.turn(3)` with no
        // assertion hung off it still fails.
        check(false, `turn(${index})`, `only ${slices.length} completed turn(s)`);
        return failedScope(recorder, `${prefix}turn ${index}: `, `only ${slices.length} turn(s)`);
      }
      return eventScope(recorder, slice, `${prefix}turn ${index}: `);
    },

    turns() {
      return slices.length;
    },
  };
}

/**
 * A scope over everything a live eval session has emitted so far.
 *
 * The session itself carries no assertion vocabulary — it is published from
 * `@alexkroman1/aai-runtime/eval`, where a matcher library would be a promise
 * this tier is not ready to make (see this package's guide: the recording runner
 * and this vocabulary are the noisy-instrument half, and they are ours). This is
 * the one line that joins the two.
 */
export function scopeOf(
  recorder: EvalRecorder,
  session: { events(): readonly SessionEvent[] },
): EvalScope {
  return eventScope(recorder, session.events());
}
