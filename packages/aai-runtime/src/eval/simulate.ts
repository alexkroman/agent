// Copyright 2026 the AAI authors. MIT license.
/**
 * A SIMULATED CALLER: a model playing the user, with a persona and a goal,
 * against a real eval session.
 *
 * Every other door on this subpath is driven by lines a case author wrote.
 * That answers "given THIS utterance, did the agent do the right thing" and
 * nothing about the conversation a real caller would have had — the follow-up
 * question, the correction, the caller who gives their details in the wrong
 * order. {@link simulateCall} closes that: a second model is handed who the
 * caller is and what they want, reads each reply, and answers it, until it
 * calls `end_call` or runs out of turns.
 *
 * **It drives the same `say()`/`send()` every case already uses**, so a
 * simulated call is an ordinary list of {@link EvalTurn}s and every reader on
 * this subpath (`turnCalling`, `expectCalled`, `toolCallsInTurns`) takes it
 * unchanged. The caller is not a new harness; it is a new author of lines.
 *
 * **`end_call` is the CALLER's tool, not the agent's.** It is offered to the
 * simulating model only, and it is how the conversation ends on the caller's
 * terms — goal met, or given up on — with a reason the result carries. A call
 * that hits `maxTurns` instead is reported as such ({@link SimulatedCall.endedBy}),
 * because "the caller never got what they came for" is the finding a
 * simulation most often exists to surface.
 *
 * Text only. The two speech stages are faked exactly as for `say()`, so what a
 * simulated call measures is the conversation ABOVE the audio boundary —
 * see `eval/session.ts` for what that excludes. `latencyMs` is the
 * committed-utterance-to-first-reply-text gap on that path: model and tool
 * time, not endpointing or synthesis.
 *
 * Grade the result with {@link judgeCall} (`eval/judge.ts`) or with ordinary
 * assertions over `turns`; both are valid and they answer different questions.
 *
 * @module
 */

import type { SessionEvent } from "@alexkroman1/aai";
import type { ProviderEnv } from "@alexkroman1/aai/host-internal";
import type { LlmProvider } from "@alexkroman1/aai/llm";
import { generateText, jsonSchema, type ModelMessage, type Tool } from "ai";
import { createLlmModelCache } from "../_llm-model-cache.ts";
import { withHostCredentialFallback } from "../providers/host-env.ts";
import type { EvalToolCall } from "./events.ts";
import type { EvalTurn } from "./session.ts";

/** Who the simulated caller is, and what they called for. */
export type SimulatedCaller = {
  /**
   * Who they are and how they talk — "a hurried commuter who answers in
   * fragments", "an elderly caller who asks for things to be repeated".
   */
  readonly persona: string;
  /**
   * What they want out of the call, stated as the CALLER would know it —
   * including the facts they hold ("order W1234", "a table for four on
   * Friday"). The simulating model is told to reveal them only when asked, as a
   * caller would.
   */
  readonly goal: string;
  /**
   * The caller's first line. Absent, the model writes one — after the
   * greeting, when the target has one.
   */
  readonly opening?: string;
};

/**
 * What a simulation drives: an `EvalSession` (`say`) or an `EvalTextAgent`
 * (`send`). Structural, so either handle passes as is.
 */
export type SimulationTarget =
  | {
      say(text: string): Promise<EvalTurn>;
      said(): readonly string[];
    }
  | {
      send(text: string): Promise<EvalTurn>;
      said(): readonly string[];
    };

/** What {@link simulateCall} takes. */
export type SimulateCallOptions = {
  /** Who is calling. */
  readonly caller: SimulatedCaller;
  /**
   * The model PLAYING the caller. Any `@alexkroman1/aai/llm` descriptor —
   * including one from `installStubLlm`, which is how a keyless run scripts the
   * caller's lines (`{ tool: "end_call", args: { reason } }` ends it).
   */
  readonly llm: LlmProvider;
  /**
   * Where the caller model's credential is resolved from. Defaults to this
   * machine's environment, the same trust decision `openEvalSession` makes.
   */
  readonly providerEnv?: ProviderEnv;
  /**
   * The most caller turns before the harness hangs up for them. Default
   * {@link DEFAULT_MAX_TURNS}.
   */
  readonly maxTurns?: number;
};

/** One exchange: what the caller said and the turn it produced. */
export type SimulatedTurn = {
  /** The caller's line. */
  readonly caller: string;
  /** The agent's turn in reply, exactly as `say()`/`send()` returned it. */
  readonly turn: EvalTurn;
  /**
   * Milliseconds from the committed utterance to the first reply text —
   * `undefined` for a turn that produced no text.
   */
  readonly latencyMs: number | undefined;
};

/** What was measured over the whole call. */
export type SimulationMetrics = {
  /** Caller turns taken. */
  readonly turns: number;
  /** Wall-clock time of the whole simulation, caller model included. */
  readonly durationMs: number;
  /** Every tool call the agent made, in order. */
  readonly toolCalls: readonly EvalToolCall[];
  /** Tool calls per tool name. */
  readonly toolCallCounts: Readonly<Record<string, number>>;
  /** Reply latency over the turns that produced text. */
  readonly latencyMs: {
    readonly mean: number | undefined;
    readonly p50: number | undefined;
    readonly max: number | undefined;
  };
};

/** A finished simulated call. */
export type SimulatedCall = {
  readonly caller: SimulatedCaller;
  /** The agent's opening line(s) before the caller spoke — empty for a text agent. */
  readonly greeting: readonly string[];
  readonly turns: readonly SimulatedTurn[];
  /**
   * `"caller"` — it called `end_call`. `"max-turns"` — the harness hung up
   * after {@link SimulateCallOptions.maxTurns}, which usually means the goal
   * was never met.
   */
  readonly endedBy: "caller" | "max-turns";
  /** The reason the caller gave to `end_call`, when it gave one. */
  readonly endReason: string | undefined;
  readonly metrics: SimulationMetrics;
  /** The call as `Agent:`/`Caller:` lines — what a judge or a failure message reads. */
  transcript(): string;
};

/** How many caller turns a simulation may take unless told otherwise. */
export const DEFAULT_MAX_TURNS = 12;

/** The name of the caller-side hang-up tool. */
export const END_CALL_TOOL = "end_call";

const endCall: Tool = {
  description:
    "Hang up. Call this once your goal is met, or when it clearly cannot be met on this call.",
  inputSchema: jsonSchema<{ reason?: string }>({
    type: "object",
    properties: {
      reason: { type: "string", description: "Why you are hanging up, in one sentence." },
    },
    additionalProperties: false,
  }),
  // No `execute`: the call IS the signal, and `generateText` stops on it.
};

function callerSystem(caller: SimulatedCaller): string {
  return [
    "You are role-playing a CALLER talking to a voice agent on the phone. You are the",
    "customer, never the agent. Stay in character for the whole call.",
    "",
    `Who you are: ${caller.persona}`,
    `What you want from this call: ${caller.goal}`,
    "",
    "Rules:",
    "- Say one short, natural spoken turn at a time — no lists, no markdown, no stage directions.",
    "- Give details only when they are asked for, the way a real caller would.",
    `- When your goal is met, or it clearly cannot be, call the ${END_CALL_TOOL} tool instead of replying.`,
  ].join("\n");
}

function sayThrough(target: SimulationTarget): (text: string) => Promise<EvalTurn> {
  return "say" in target ? (text) => target.say(text) : (text) => target.send(text);
}

/** Committed utterance → first reply text, read off the turn's own event stamps. */
function latencyOf(events: readonly SessionEvent[]): number | undefined {
  const start = events.find((e) => e.type === "user-transcript.committed")?.meta.at;
  const first = events.find(
    (e) => e.type === "agent-transcript.updated" || e.type === "agent-transcript.committed",
  )?.meta.at;
  if (start === undefined || first === undefined) return undefined;
  return Math.max(0, first - start);
}

function summarize(values: readonly number[]): SimulationMetrics["latencyMs"] {
  if (values.length === 0) return { mean: undefined, p50: undefined, max: undefined };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    mean: Math.round(sorted.reduce((sum, v) => sum + v, 0) / sorted.length),
    p50: sorted[Math.floor((sorted.length - 1) / 2)],
    max: sorted.at(-1),
  };
}

function metricsOf(turns: readonly SimulatedTurn[], durationMs: number): SimulationMetrics {
  const toolCalls = turns.flatMap((t) => t.turn.toolCalls);
  const toolCallCounts: Record<string, number> = {};
  for (const call of toolCalls) toolCallCounts[call.name] = (toolCallCounts[call.name] ?? 0) + 1;
  return {
    turns: turns.length,
    durationMs,
    toolCalls,
    toolCallCounts,
    latencyMs: summarize(turns.flatMap((t) => (t.latencyMs === undefined ? [] : [t.latencyMs]))),
  };
}

function transcriptOf(greeting: readonly string[], turns: readonly SimulatedTurn[]): string {
  const lines = greeting.map((line) => `Agent: ${line}`);
  for (const { caller, turn } of turns) {
    lines.push(`Caller: ${caller}`);
    for (const call of turn.toolCalls) {
      lines.push(
        `  [tool ${call.name}(${JSON.stringify(call.args)}) → ${call.result ?? "(none)"}]`,
      );
    }
    lines.push(`Agent: ${turn.text}`);
  }
  return lines.join("\n");
}

/**
 * The caller's next move: a line to say, or a hang-up.
 *
 * The conversation is presented from the CALLER's side — the agent's lines as
 * `user`, the caller's own as `assistant` — because that is the only framing in
 * which "your next turn" means the caller's.
 */
async function nextMove(
  model: Parameters<typeof generateText>[0]["model"],
  system: string,
  history: readonly ModelMessage[],
): Promise<{ say: string } | { hangUp: string | undefined }> {
  const result = await generateText({
    model,
    system,
    messages: [...history],
    tools: { [END_CALL_TOOL]: endCall },
  });
  const hangUp = result.toolCalls.find((call) => call.toolName === END_CALL_TOOL);
  if (hangUp !== undefined) {
    const reason = (hangUp.input as { reason?: unknown } | undefined)?.reason;
    return { hangUp: typeof reason === "string" ? reason : undefined };
  }
  const text = result.text.trim();
  // A caller that says nothing and does not hang up has nothing left to say;
  // committing an empty utterance would measure the harness, not the agent.
  return text === "" ? { hangUp: "the caller had nothing further to say" } : { say: text };
}

/**
 * Run a simulated call against `target` and hand back every turn, the way it
 * ended, and what was measured.
 *
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { llm } from "@alexkroman1/aai/llm";
 * import { openEvalSession } from "@alexkroman1/aai-runtime/eval";
 * import { simulateCall } from "@alexkroman1/aai-runtime/eval/simulate";
 *
 * export async function hurriedCaller(): Promise<void> {
 *   const session = await openEvalSession({ agent: agent({ name: "Order Desk" }) });
 *   try {
 *     const call = await simulateCall(session, {
 *       caller: {
 *         persona: "a polite but hurried customer",
 *         goal: "find out whether order W1234 has shipped",
 *       },
 *       llm: llm({ provider: "anthropic", model: "claude-haiku-4-5" }),
 *     });
 *     if (call.endedBy !== "caller") throw new Error(call.transcript());
 *     console.log(call.metrics.toolCallCounts, call.metrics.latencyMs);
 *   } finally {
 *     await session.close();
 *   }
 * }
 * ```
 *
 * The target is used as is and left OPEN — whoever opened it closes it, the
 * same ownership every other door here keeps.
 */
export async function simulateCall(
  target: SimulationTarget,
  options: SimulateCallOptions,
): Promise<SimulatedCall> {
  const started = Date.now();
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const model = createLlmModelCache(options.providerEnv ?? withHostCredentialFallback({}))(
    options.llm,
  );
  const system = callerSystem(options.caller);
  const say = sayThrough(target);
  const greeting = [...target.said()];
  // Opens on a `user` message either way: several providers refuse a
  // conversation whose first message is the model's own, and a text agent has
  // no greeting to open with.
  const history: ModelMessage[] =
    greeting.length === 0
      ? [{ role: "user", content: "(the line connects)" }]
      : greeting.map((line) => ({ role: "user", content: line }));
  const turns: SimulatedTurn[] = [];
  let endedBy: SimulatedCall["endedBy"] = "max-turns";
  let endReason: string | undefined;

  while (turns.length < maxTurns) {
    const move =
      turns.length === 0 && options.caller.opening !== undefined
        ? { say: options.caller.opening }
        : await nextMove(model, system, history);
    if ("hangUp" in move) {
      endedBy = "caller";
      endReason = move.hangUp;
      break;
    }
    const turn = await say(move.say);
    turns.push({ caller: move.say, turn, latencyMs: latencyOf(turn.events) });
    history.push({ role: "assistant", content: move.say });
    history.push({ role: "user", content: turn.text === "" ? "(silence)" : turn.text });
  }

  const metrics = metricsOf(turns, Date.now() - started);
  return {
    caller: options.caller,
    greeting,
    turns,
    endedBy,
    endReason,
    metrics,
    transcript: () => transcriptOf(greeting, turns),
  };
}
