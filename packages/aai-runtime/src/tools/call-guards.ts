// Copyright 2026 the AAI authors. MIT license.
/**
 * A conversation's guards on its tool calls — `format-mirror.ts` (an argument
 * shaped unlike the records) and `failed-call-memo.ts` (a call that already
 * failed with the same arguments) — held as ONE object.
 *
 * ## Why one
 *
 * Both answer a call before it runs, both see each settled result, and both
 * are scoped to the same conversation. Held separately, each was its own
 * optional field on two context types, built by hand at every session, with a
 * reset rule of its own — and the copies had drifted (a text agent got one but
 * not the other, and both read a front-trimmed history as a reset). A new
 * guard is a field here and a line in each method.
 *
 * ## When a conversation ends
 *
 * A snapshot sharing NO message with what was seen before is a new
 * conversation (a reset), and every guard forgets. Not a SHORTER one:
 * retention trims a long session's history from the front, and treating that
 * as a reset forgot every refusal and re-read the whole window on each call.
 * An EMPTY snapshot is not a reset either — a subagent's and `TextAgent.tools`'
 * views always are, and their own settled results are all they have.
 */

import { FailedCallMemo } from "./failed-call-memo.ts";
import { FormatMirror } from "./format-mirror.ts";

type HistoryMessage = { role: string; content?: unknown };

/**
 * See this module's doc. One per conversation; never shared across sessions.
 * `rememberFailures` is for a conversation the caller can be asked to repair
 * (a session) — a text agent's tool set and a subagent run leave it off.
 */
export class ToolCallGuards {
  readonly #mirror = new FormatMirror();
  readonly #failures: FailedCallMemo | undefined;
  /** Every history message seen — each is read once, and a reset is recognized. */
  readonly #seen = new WeakSet<object>();
  #seenAny = false;

  constructor(opts: { rememberFailures: boolean }) {
    this.#failures = opts.rememberFailures ? new FailedCallMemo() : undefined;
  }

  /**
   * A refusal to answer the call with instead of running it, or `undefined` to
   * run it. `history` is the call's history snapshot.
   */
  refuse(
    name: string,
    args: Readonly<Record<string, unknown>>,
    history: readonly HistoryMessage[],
  ): string | undefined {
    this.#read(history);
    return this.#mirror.refuse(name, args) ?? this.#failures?.refuse(name, args);
  }

  /**
   * The settled call's result, WHOLE — `recorded` is the history's (capped)
   * copy, marked seen so it is not read again. Returns the note for the
   * MODEL's copy of a failure, or `undefined`.
   */
  settle(
    name: string,
    args: Readonly<Record<string, unknown>>,
    result: string,
    recorded: object,
  ): string | undefined {
    this.#markSeen(recorded);
    this.#mirror.observeResult(result);
    return this.#failures?.settle(name, args, result);
  }

  #markSeen(message: object): void {
    this.#seen.add(message);
    this.#seenAny = true;
  }

  #read(history: readonly HistoryMessage[]): void {
    const fresh = !history.some((message) => this.#seen.has(message));
    if (this.#seenAny && history.length > 0 && fresh) {
      this.#mirror.reset();
      this.#failures?.reset();
    }
    const unseen = history.filter((message) => !this.#seen.has(message));
    for (const message of unseen) this.#markSeen(message);
    this.#mirror.read(unseen);
  }
}
