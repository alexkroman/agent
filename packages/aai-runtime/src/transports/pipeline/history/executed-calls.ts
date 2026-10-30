// Copyright 2026 the AAI authors. MIT license.
/**
 * Which tool calls a turn that did not finish really ran, so its history can
 * say so — in BOTH views.
 *
 * **A step's messages exist only once the step FINISHES**, and a turn can end
 * after a tool executed and before that: a barge-in, or a failure (a fatal
 * sibling call, a stream error, a stall) landing while a sibling call was still
 * running or before `onStepFinish`. Only completed steps were kept, so such a
 * call left no trace in the model's view, and the next turn re-sent it.
 * Measured on tau2-bench retail: of 216 aborted LLM turns, 91 had already
 * called tools, 22 of them a write, and in 3 sims the next turn re-sent the
 * identical write, which then failed ("Non-delivered order cannot be
 * returned") because the first one had succeeded.
 *
 * So the tool layer reports each call here (`toVercelTools`' `trackCall`):
 * when it STARTS, when it actually reaches `executeTool` (`ran`), and when it
 * SETTLES — or throws a fatal error, which the model is never given. The turn
 * then asks for the calls no completed step answers, and each lands in one of
 * three classes, decided ONCE per call, at the first of its result being
 * recorded, its settling, or the turn reading it:
 *
 * | settled before the cut | ran | recorded as                                    |
 * | ---------------------- | --- | ---------------------------------------------- |
 * | yes                    | any | its REAL result (a refusal is a real answer)   |
 * | no                     | yes | {@link INTERRUPTED_TOOL_CALL_RESULT}           |
 * | no                     | no  | nothing — it never ran, so it is not history   |
 *
 * "The cut" is the CALL's own signal aborting (the request signal: the turn's,
 * the fatal latch, the stall watchdog), or the turn reading its record — a call
 * still pending then is past the point where history can wait for it. Deciding
 * once is what keeps the two views agreeing: the conversation view
 * ({@link ExecutedCallLedger.conversationResult}, what `ctx.messages` reads)
 * and the LLM view ({@link TurnToolCalls.unanswered}) read the same verdict.
 *
 * **A call still running at the cut is recorded as interrupted with an honest
 * "outcome unknown" result, rather than awaited.** Awaiting is not available:
 * `executeTool` settles the await on the call signal and hands back a
 * cancellation failure while the tool body itself keeps going unless it reads
 * `ctx.signal` (`../../../tools/executor.ts`), so the host never learns the
 * write's real outcome — and holding the next turn behind a write the caller
 * has just talked over would delay the answer to the barge-in by the tool's
 * whole latency. What the host CAN NOT do is pass on that cancellation: it
 * tells the model (and any tool reading `ctx.messages`) the action did not
 * happen, which is exactly the belief that made it re-send a write that had
 * succeeded. "Interrupted, it may have taken effect, check before repeating" is
 * the true statement, and it moves the model toward a read rather than a blind
 * retry.
 */

import type { Message } from "@alexkroman1/aai";
import type { ModelMessage } from "ai";

/**
 * What the model is told a call still running at the cut returned. Worded for
 * both cuts — a barge-in and a failed turn — since it says nothing about why.
 */
export const INTERRUPTED_TOOL_CALL_RESULT: string =
  "Interrupted: the reply was cut off before this call returned, so its outcome is unknown and it " +
  "may already have taken effect. Do not repeat it blindly — first check whether it took " +
  "effect (for example by looking the record up again).";

/** One call an unfinished turn ran that no completed step answers. */
export interface ExecutedToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  /** The arguments as the model sent them — what its `tool-call` part carries. */
  readonly input: unknown;
  /** The model's copy of the result, or {@link INTERRUPTED_TOOL_CALL_RESULT}. */
  readonly output: string;
  /** Still running at the cut: its {@link output} is the honest unknown. */
  readonly interrupted: boolean;
}

/** One call's lifecycle, as the tool layer reports it. */
export interface TrackedToolCall {
  /** The call is about to reach `executeTool`: from here it may have side effects. */
  ran(): void;
  /** The call settled; `forModel` is the copy the model is handed. */
  settled(forModel: string): void;
  /** The call threw a FATAL error: the model is never given it, so neither is history. */
  threw(): void;
}

/** The current turn's record — see {@link ExecutedCallLedger.beginTurn}. */
export interface TurnToolCalls {
  /**
   * The calls this turn ran that `persisted` (its completed steps' messages)
   * does not already carry, in the order they started. Reading is a cut: a
   * call still pending is decided here, as interrupted.
   */
  unanswered(persisted: readonly ModelMessage[]): ExecutedToolCall[];
  /** Stop attributing new calls to this turn. Idempotent. */
  end(): void;
}

/** Session-scoped: the tool set reports into it, each turn reads its own. */
export interface ExecutedCallLedger {
  /**
   * A call is starting under `signal` (its own — the request's). Answers
   * `undefined` when no turn is open or the call is already cut: such a call
   * never runs.
   */
  track(call: {
    toolCallId: string;
    toolName: string;
    input: unknown;
    signal?: AbortSignal | undefined;
  }): TrackedToolCall | undefined;
  /**
   * The conversation-view message for a settled call's recorded result, by
   * the same verdict the LLM view gets: unchanged for a call that settled
   * before the cut or that this ledger does not track, the honest unknown for
   * one that ran past it, and `null` — record nothing — for one that never
   * ran. Never a cancellation the tool body may have outlived.
   */
  conversationResult(message: Message): Message | null;
  /**
   * Open a turn's record. A call is attributed to the turn open when it
   * STARTS, so one settling after the next turn began still lands in its own.
   */
  beginTurn(): TurnToolCalls;
}

type Entry = {
  readonly call: { toolCallId: string; toolName: string; input: unknown };
  readonly signal: AbortSignal | undefined;
  ran: boolean;
  /** Decided once — see the module doc. `undefined` while pending. */
  verdict?: "settled" | "cut" | "threw";
  output?: string;
};

/** The call ids `messages` already carries, as a call or as a result. */
function idsIn(messages: readonly ModelMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if ((m.role !== "assistant" && m.role !== "tool") || typeof m.content === "string") continue;
    for (const part of m.content) {
      if (part.type === "tool-call" || part.type === "tool-result") ids.add(part.toolCallId);
    }
  }
  return ids;
}

/** Settle `entry`'s verdict if it is still open, reading its signal NOW. */
function decide(entry: Entry): Entry["verdict"] {
  entry.verdict ??= entry.signal?.aborted === true ? "cut" : "settled";
  return entry.verdict;
}

/**
 * One entry as history records it, by the module doc's table — and READING is
 * a cut: whatever is still pending is past waiting for.
 */
function asExecuted(entry: Entry): ExecutedToolCall[] {
  entry.verdict ??= "cut";
  const { call, verdict, output, ran } = entry;
  if (verdict === "settled" && output !== undefined) {
    return [{ ...call, output, interrupted: false }];
  }
  if (verdict === "cut" && ran) {
    return [{ ...call, output: INTERRUPTED_TOOL_CALL_RESULT, interrupted: true }];
  }
  return [];
}

/** Create a session's {@link ExecutedCallLedger}. */
export function createExecutedCallLedger(): ExecutedCallLedger {
  let current: Entry[] | undefined;
  // Entries by call id, for `conversationResult`. Rebuilt per turn keeping only
  // what is still pending, so it holds two turns' calls at most.
  let byId = new Map<string, Entry>();
  return {
    track({ signal, ...call }) {
      const entries = current;
      if (entries === undefined || signal?.aborted === true) return;
      const entry: Entry = { call, signal, ran: false };
      entries.push(entry);
      byId.set(call.toolCallId, entry);
      return {
        ran: () => {
          // A cut before this point means `executeTool` refuses the call.
          if (entry.verdict === undefined && signal?.aborted !== true) entry.ran = true;
        },
        settled: (forModel) => {
          if (decide(entry) === "settled") entry.output = forModel;
        },
        threw: () => {
          entry.verdict ??= "threw";
        },
      };
    },
    conversationResult(message) {
      const entry = message.toolCallId === undefined ? undefined : byId.get(message.toolCallId);
      if (entry === undefined) return message;
      const verdict = decide(entry);
      if (verdict === "settled") {
        // Provisional: `settled` replaces it with the model's copy (rows, hints).
        entry.output ??= message.content;
        return message;
      }
      if (!entry.ran) return null;
      return { ...message, content: INTERRUPTED_TOOL_CALL_RESULT };
    },
    beginTurn() {
      const entries: Entry[] = [];
      current = entries;
      byId = new Map([...byId].filter(([, e]) => e.verdict === undefined));
      return {
        unanswered(persisted) {
          const known = idsIn(persisted);
          return entries.flatMap((entry) =>
            known.has(entry.call.toolCallId) ? [] : asExecuted(entry),
          );
        },
        end() {
          if (current === entries) current = undefined;
        },
      };
    },
  };
}

/**
 * The step an interrupted turn never finished, rebuilt as the SDK would have
 * built it: ONE assistant message — the text the caller heard first, since a
 * model response puts its words ahead of its calls — carrying every call, then
 * ONE `tool` message answering every call. Pushed together, so retention and
 * the pairing guard never see half of it. Empty when no call ran.
 */
export function interruptedStepMessages(
  calls: readonly ExecutedToolCall[],
  heardText: string | undefined,
): ModelMessage[] {
  if (calls.length === 0) return [];
  return [
    {
      role: "assistant",
      content: [
        ...(heardText === undefined ? [] : [{ type: "text" as const, text: heardText }]),
        ...calls.map((c) => ({
          type: "tool-call" as const,
          toolCallId: c.toolCallId,
          toolName: c.toolName,
          input: c.input,
        })),
      ],
    },
    {
      role: "tool",
      content: calls.map((c) => ({
        type: "tool-result" as const,
        toolCallId: c.toolCallId,
        toolName: c.toolName,
        output: { type: "text" as const, value: c.output },
      })),
    },
  ];
}
