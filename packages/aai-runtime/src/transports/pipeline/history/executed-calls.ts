// Copyright 2026 the AAI authors. MIT license.
/**
 * Which tool calls an INTERRUPTED turn really ran, so its history can say so.
 *
 * **A step's messages exist only once the step FINISHES**, and a barge-in can
 * land after a tool executed and before that: the step's model call ended on
 * its tool calls, the SDK ran them, and the abort arrived while a sibling call
 * was still running (or before `onStepFinish`). `persistInterruptedTurn` kept
 * only completed steps, so such a call left no trace in the model's view, and
 * the next turn re-sent it. Measured on tau2-bench retail: of 216 aborted LLM
 * turns, 91 had already called tools, 22 of them a write, and in 3 sims the
 * next turn re-sent the identical write, which then failed ("Non-delivered
 * order cannot be returned") because the first one had succeeded.
 *
 * So the tool layer reports each call here (`toVercelTools`' `trackCall`):
 * when it STARTS, when it actually reaches `executeTool` (`ran`), and when it
 * SETTLES. At persistence the turn asks for the calls no completed step
 * answers, and each lands in one of three classes:
 *
 * | settled before the cut | ran | persisted as                                   |
 * | ---------------------- | --- | ---------------------------------------------- |
 * | yes                    | any | its REAL result (a refusal is a real answer)   |
 * | no                     | yes | {@link INTERRUPTED_TOOL_CALL_RESULT}           |
 * | no                     | no  | nothing — it never ran, so it is not history   |
 *
 * **A call still running at the cut is recorded as interrupted with an honest
 * "outcome unknown" result, rather than awaited.** Awaiting is not available:
 * `executeTool` settles the await on the turn signal and hands back a
 * `cancelled` failure while the tool body itself keeps going unless it reads
 * `ctx.signal` (`../../../tools/executor.ts`), so the host never learns the
 * write's real outcome — and holding the next turn behind a write the caller
 * has just talked over would delay the answer to the barge-in by the tool's
 * whole latency. What the host CAN NOT do is pass on that `cancelled` result:
 * it tells the model the action did not happen, which is exactly the belief
 * that made it re-send a write that had succeeded. "Interrupted, it may have
 * taken effect, check before repeating" is the true statement, and it moves
 * the model toward a read rather than a blind retry.
 */

import type { ModelMessage } from "ai";

/** What the model is told a call still running at the cut returned. */
export const INTERRUPTED_TOOL_CALL_RESULT: string =
  "Interrupted: the caller spoke before this call returned, so its outcome is unknown and it " +
  "may already have taken effect. Do not repeat it blindly — first check whether it took " +
  "effect (for example by looking the record up again).";

/** One call an interrupted turn ran that no completed step answers. */
export interface ExecutedToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  /** The arguments as the model sent them — what its `tool-call` part carries. */
  readonly input: unknown;
  /** The model's copy of the result, or {@link INTERRUPTED_TOOL_CALL_RESULT}. */
  readonly output: string;
  /** Still running when the turn was cut: its {@link output} is the honest unknown. */
  readonly interrupted: boolean;
}

/** One call's lifecycle, as the tool layer reports it. */
export interface TrackedToolCall {
  /** The call is about to reach `executeTool`: from here it may have side effects. */
  ran(): void;
  /** The call settled; `forModel` is the copy the model is handed. */
  settled(forModel: string): void;
}

/** The current turn's record — see {@link ExecutedCallLedger.beginTurn}. */
export interface TurnToolCalls {
  /**
   * The calls this turn ran that `persisted` (its completed steps' messages)
   * does not already carry, in the order they started.
   */
  unanswered(persisted: readonly ModelMessage[]): ExecutedToolCall[];
  /** Stop attributing new calls to this turn. Idempotent. */
  end(): void;
}

/** Session-scoped: the tool set reports into it, each turn reads its own. */
export interface ExecutedCallLedger {
  /**
   * A call is starting. Answers `undefined` when no turn is open or the open
   * turn is already cut — a call that starts then never ran.
   */
  track(call: {
    toolCallId: string;
    toolName: string;
    input: unknown;
  }): TrackedToolCall | undefined;
  /**
   * Open a turn's record. A call is attributed to the turn open when it
   * STARTS, so one settling after the next turn began still lands in its own.
   */
  beginTurn(signal: AbortSignal): TurnToolCalls;
}

type Entry = {
  readonly call: { toolCallId: string; toolName: string; input: unknown };
  ran: boolean;
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

/** Create a session's {@link ExecutedCallLedger}. */
export function createExecutedCallLedger(): ExecutedCallLedger {
  let current: { signal: AbortSignal; entries: Entry[] } | undefined;
  return {
    track(call) {
      const turn = current;
      if (turn === undefined || turn.signal.aborted) return;
      const entry: Entry = { call, ran: false };
      turn.entries.push(entry);
      // Both read the cut at the moment they fire: anything after it is not
      // something the record may claim (see the module doc's table).
      return {
        ran: () => {
          if (!turn.signal.aborted) entry.ran = true;
        },
        settled: (forModel) => {
          if (!turn.signal.aborted) entry.output = forModel;
        },
      };
    },
    beginTurn(signal) {
      const turn = { signal, entries: [] as Entry[] };
      current = turn;
      return {
        unanswered(persisted) {
          const known = idsIn(persisted);
          const out: ExecutedToolCall[] = [];
          for (const { call, ran, output } of turn.entries) {
            if (known.has(call.toolCallId)) continue;
            if (output !== undefined) out.push({ ...call, output, interrupted: false });
            else if (ran) {
              out.push({ ...call, output: INTERRUPTED_TOOL_CALL_RESULT, interrupted: true });
            }
          }
          return out;
        },
        end() {
          if (current === turn) current = undefined;
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
