// Copyright 2026 the AAI authors. MIT license.
/**
 * Property test: a cancel landing at every point of a reply's tool work, in the
 * SESSION CORE (`core.ts` over `reply-tracker.ts`, `tool-steps.ts`,
 * `reply-done.ts`) with the REAL executor (`../tools/executor.ts`) underneath.
 *
 * `../integration/pipeline-fuzz.integration.test.ts` already walks barge-ins
 * through the PIPELINE transport on real timers, and
 * `../integration/s2s-fuzz.integration.test.ts` through the S2S transport. Both
 * sit ABOVE the core and treat its tool bookkeeping as given; neither puts a
 * cancel between a tool's settlement and the `reply.done` that flushes it, and
 * neither holds a tool body open while the reply it belongs to is replaced. This
 * suite is that missing layer: the transport is the inert fake from
 * `_core-harness.ts`, the reports are generated, and `fc.scheduler` decides when
 * each held tool body returns relative to the generated reports.
 *
 * Audio ordering against a cancel is deliberately NOT an oracle here: the core
 * forwards `onAudioChunk` unconditionally while it runs, and dropping a
 * cancelled reply's audio is the TRANSPORT's job (both fuzzers above own it).
 * What the core does promise about audio — nothing after `stop()` — is checked.
 *
 * Every macrotask the executor yields (`yieldTick`, a `setImmediate`) is
 * drained inside the scheduler's `act`, so a held body is registered with the
 * scheduler before the next task is picked; without it the scheduler would see
 * an idle queue while a call was still on its way to its body.
 */

import { setImmediate as nextImmediate } from "node:timers/promises";
import type { Message, SessionEvent, ToolContext } from "@alexkroman1/aai";
import type { ExecuteTool } from "@alexkroman1/aai/host-internal";
import { toolset } from "@alexkroman1/aai/manifest";
import type { ClientSink } from "@alexkroman1/aai/protocol";
import fc from "fast-check";
import { describe, expect, test, vi } from "vitest";
import { makeTool } from "../_agent-test-utils.ts";
import { silentLogger } from "../logger.ts";
import { executeToolCall } from "../tools/index.ts";
import { makeCore, makeSink } from "./_core-harness.ts";
import type { ServerSession } from "./core-types.ts";

type ActionKind =
  | "replyStart"
  | "toolCalled"
  | "audio"
  | "replyDone"
  | "progress"
  | "transportCancel"
  | "clientCancel"
  | "reset";

/**
 * Weighted toward the two events a cancel has to race: a tool call (so there
 * is work in flight) and a `reply.done` (so there is a flush to land between).
 */
const actionArb: fc.Arbitrary<ActionKind> = fc.oneof(
  { weight: 3, arbitrary: fc.constant("replyStart" as const) },
  { weight: 5, arbitrary: fc.constant("toolCalled" as const) },
  { weight: 1, arbitrary: fc.constant("audio" as const) },
  { weight: 4, arbitrary: fc.constant("replyDone" as const) },
  { weight: 1, arbitrary: fc.constant("progress" as const) },
  { weight: 2, arbitrary: fc.constant("transportCancel" as const) },
  { weight: 2, arbitrary: fc.constant("clientCancel" as const) },
  { weight: 1, arbitrary: fc.constant("reset" as const) },
);

/** Drain the executor's `setImmediate` yields — four rounds covers its deepest chain. */
async function drainImmediates(): Promise<void> {
  for (let i = 0; i < 4; i++) await nextImmediate();
}

type Reply = { id: string; superseded: boolean };
type Call = {
  id: string;
  /** The reply the core bound the call to, or null when none was active. */
  reply: Reply | null;
  /** Conversation epoch (bumped by `reset`) the call was issued in. */
  epoch: number;
  bodyStarted: boolean;
  bodyDone: boolean;
  signal: AbortSignal | null;
};

/** Counted states — the floors at the bottom of the property read these. */
const cov = {
  runs: 0,
  bodyHeldAcrossSupersede: 0,
  cancelledBeforeBody: 0,
  resultsFlushed: 0,
  staleResultDropped: 0,
  repliesCompleted: 0,
  stopWithBodyInFlight: 0,
};

/** The outside view of one run: what the core was told, and what it did. */
type World = {
  s: fc.Scheduler;
  violations: string[];
  replySeq: number;
  callSeq: number;
  epoch: number;
  stopped: boolean;
  /** The reply the core's `currentReplyId` names, mirrored from the outside. */
  active: Reply | null;
  /** The reply object the core holds, even once ended — what `clientCancel` aborts. */
  held: Reply | null;
  calls: Map<string, Call>;
  completedTools: Map<string, number>;
  sentResults: Set<string>;
  completedReplies: Set<string>;
};

function newWorld(s: fc.Scheduler): World {
  return {
    s,
    violations: [],
    replySeq: 0,
    callSeq: 0,
    epoch: 0,
    stopped: false,
    active: null,
    held: null,
    calls: new Map(),
    completedTools: new Map(),
    sentResults: new Set(),
    completedReplies: new Set(),
  };
}

const flag = (w: World, what: string): void => {
  w.violations.push(what);
};

function noteToolCompleted(w: World, callId: string): void {
  w.completedTools.set(callId, (w.completedTools.get(callId) ?? 0) + 1);
  const call = w.calls.get(callId);
  if (call !== undefined && call.epoch < w.epoch) {
    flag(w, `${call.id}'s tool.completed was published after the reset that dropped it`);
  }
}

function noteReplyCompleted(w: World): void {
  // The core nulls its id as it emits this, so `active` is the reply ending.
  const ending = w.active;
  if (ending === null) {
    flag(w, "reply.completed with no active reply");
    return;
  }
  if (w.completedReplies.has(ending.id)) flag(w, `second reply.completed for ${ending.id}`);
  w.completedReplies.add(ending.id);
  cov.repliesCompleted++;
  w.active = null;
}

function clientOf(w: World): ClientSink {
  const base = makeSink();
  return {
    ...base.sink,
    event: (e: SessionEvent) => {
      if (w.stopped) flag(w, `event ${e.type} reached the client after stop()`);
      if (e.type === "tool.completed") noteToolCompleted(w, e.toolCallId);
      else if (e.type === "reply.completed") noteReplyCompleted(w);
      base.sink.event(e);
    },
    playAudioChunk: (chunk) => {
      if (w.stopped) flag(w, "audio reached the client after stop()");
      base.sink.playAudioChunk(chunk);
    },
  };
}

/** A reset conversation must not carry the old one's results. */
function checkHistory(w: World, call: Call, messages: readonly Message[]): void {
  for (const m of messages) {
    const from = m.role === "tool" && m.toolCallId ? w.calls.get(m.toolCallId) : undefined;
    if (from !== undefined && from.epoch < call.epoch) {
      flag(w, `${call.id} saw ${from.id}'s result from before a reset`);
    }
  }
}

/** The tool's body: held by the scheduler until it decides the call returns. */
async function toolBody(w: World, callId: string, ctx: ToolContext): Promise<string> {
  const call = w.calls.get(callId);
  if (call === undefined) {
    flag(w, `tool body ran for an unknown call ${callId}`);
    return "?";
  }
  call.bodyStarted = true;
  call.signal = ctx.signal;
  if (call.reply?.superseded === true) {
    flag(w, `tool body for ${callId} started after its reply was superseded`);
  }
  checkHistory(w, call, ctx.messages);
  try {
    await w.s.schedule(Promise.resolve(), `body ${callId}`);
    if (call.reply?.superseded === true) cov.bodyHeldAcrossSupersede++;
    return `result ${callId}`;
  } finally {
    call.bodyDone = true;
  }
}

/** The REAL executor, over a one-tool toolset whose body {@link toolBody} holds. */
function executorOf(w: World): ExecuteTool {
  return (name, args, sessionId, messages, options) => {
    const callId = options?.toolCallId ?? "";
    return executeToolCall(name, args, {
      toolset: toolset("files", {
        lookup: makeTool({ execute: (_a, ctx) => toolBody(w, callId, ctx) }),
      }),
      env: {},
      sessionId,
      messages,
      signal: options?.signal,
      logger: silentLogger,
    });
  };
}

/** A result reaches the transport only for the live reply, once, with its own answer. */
function checkSentResult(w: World, callId: string, result: string): void {
  if (w.stopped) flag(w, `sendToolResult(${callId}) after stop()`);
  if (w.sentResults.has(callId)) flag(w, `${callId}'s result sent twice`);
  w.sentResults.add(callId);
  // A body answers with its own id; anything else is the executor's cancel.
  if (result.startsWith("result ") && result !== `result ${callId}`) {
    flag(w, `${callId} was answered with "${result}"`);
  }
  const reply = w.calls.get(callId)?.reply;
  if (reply === undefined) flag(w, `result sent for unknown call ${callId}`);
  else if (reply === null) flag(w, `result sent for ${callId}, issued with no reply`);
  else if (reply.superseded) {
    flag(w, `${callId}'s result reached the transport after its reply was superseded`);
  } else if (reply !== w.held) {
    flag(w, `${callId}'s result sent while another reply is current`);
  } else cov.resultsFlushed++;
}

/** The reply in hand is replaced or dropped: everything bound to it is stale. */
function supersede(w: World): void {
  if (w.held !== null) w.held.superseded = true;
}

function dropReply(w: World): void {
  supersede(w);
  w.held = null;
  w.active = null;
}

/** One generated step, as the transport or the client would send it. */
const ACTIONS: Record<ActionKind, (w: World, core: ServerSession) => void> = {
  replyStart(w, core) {
    supersede(w);
    w.held = { id: `r${++w.replySeq}`, superseded: false };
    w.active = w.held;
    core.onReplyStarted(w.held.id);
  },
  toolCalled(w, core) {
    const id = `c${++w.callSeq}`;
    w.calls.set(id, {
      id,
      reply: w.active,
      epoch: w.epoch,
      bodyStarted: false,
      bodyDone: false,
      signal: null,
    });
    core.report({ type: "tool.called", toolCallId: id, toolName: "lookup", args: {} });
  },
  audio(_w, core) {
    core.onAudioChunk(new Uint8Array([1, 2]));
  },
  replyDone(_w, core) {
    core.report({ type: "reply.completed" });
  },
  progress(_w, core) {
    core.report({ type: "agentTranscript.updated", text: "…" });
  },
  transportCancel(w, core) {
    dropReply(w);
    core.report({ type: "reply.cancelled" });
  },
  clientCancel(_w, core) {
    // Aborts the reply's tools WITHOUT replacing the reply (`commands.ts`).
    // Its calls still owe the transport an answer, so it is not superseded.
    core.command({ type: "cancel" });
  },
  reset(w, core) {
    dropReply(w);
    w.epoch++;
    core.command({ type: "reset" });
  },
};

/**
 * stop() must settle WITHOUT the scheduler releasing anything still held: the
 * abort is what unblocks the drain, not the bodies returning.
 */
async function stopAndCheck(w: World, core: ServerSession): Promise<void> {
  const inFlight = [...w.calls.values()].filter((c) => c.bodyStarted && !c.bodyDone).length;
  if (inFlight > 0) cov.stopWithBodyInFlight++;
  let stopResolved = false;
  const stopping = core.stop().then(() => {
    stopResolved = true;
  });
  await drainImmediates();
  if (!stopResolved) flag(w, `stop() hung with ${inFlight} tool body(ies) held`);
  w.stopped = true;
  for (const c of w.calls.values()) {
    if (c.bodyStarted && !c.bodyDone && c.signal?.aborted !== true) {
      flag(w, `${c.id}'s body is still running after stop() with an un-aborted signal`);
    }
  }
  // Release whatever is still held, so nothing outlives the run.
  await w.s.waitIdle();
  await stopping;
}

/**
 * A call with no active reply is refused before it runs, and one a reset
 * dropped may settle on either side of it (`tool-steps.ts`); every other call
 * is answered exactly once.
 */
function checkCompletions(w: World): void {
  for (const c of w.calls.values()) {
    const n = w.completedTools.get(c.id) ?? 0;
    const owed = c.reply !== null && c.epoch === w.epoch;
    if (n > 1) flag(w, `${c.id} got ${n} tool.completed`);
    else if (n === 0 && owed) flag(w, `${c.id} never completed`);
    else if (n === 1 && c.reply === null) flag(w, `${c.id} completed with no reply to run in`);
    countSuperseded(w, c, n);
  }
}

function countSuperseded(w: World, c: Call, completions: number): void {
  if (c.reply?.superseded !== true) return;
  if (!c.bodyStarted) cov.cancelledBeforeBody++;
  if (completions === 1 && !w.sentResults.has(c.id)) cov.staleResultDropped++;
}

async function runOne(
  s: fc.Scheduler,
  actions: readonly ActionKind[],
  stopEarly: boolean,
): Promise<string[]> {
  const w = newWorld(s);
  const { core, transport } = makeCore({
    executeTool: executorOf(w),
    client: clientOf(w),
    logger: silentLogger,
  });
  vi.mocked(transport.sendToolResult).mockImplementation((callId: string, result: string) =>
    checkSentResult(w, callId, result),
  );

  await core.start();
  try {
    const seq = s.scheduleSequence(
      actions.map((kind, i) => ({
        label: `${i}:${kind}`,
        builder: async () => ACTIONS[kind](w, core),
      })),
    );
    await s.waitFor(seq.task);
    if (!stopEarly) await s.waitIdle();
  } finally {
    await stopAndCheck(w, core);
  }
  checkCompletions(w);
  return w.violations;
}

describe("session core: cancel racing tool work", () => {
  test("a cancelled reply's tool work never reaches the transport, and nothing outlives stop()", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler({
          act: async (f) => {
            await f();
            await drainImmediates();
          },
        }),
        fc.array(actionArb, { minLength: 4, maxLength: 24 }),
        fc.boolean(),
        async (s, actions, stopEarly) => {
          cov.runs++;
          const violations = await runOne(s, actions, stopEarly);
          expect(violations, `${violations.join("\n")}\n${String(s)}`).toEqual([]);
        },
      ),
      { numRuns: 150 },
    );

    // Coverage floors, each under the observed minimum (`pnpm floors:sample
    // --runs 20`): an all-green property proves nothing about a state the
    // generator never reached.
    // Measured over 20 runs: 10-24.
    expect(cov.bodyHeldAcrossSupersede, "no body was held across a cancel").toBeGreaterThan(4);
    // Measured over 20 runs: 2-18.
    expect(cov.cancelledBeforeBody, "no cancel beat a call to its body").toBeGreaterThan(0);
    // Measured over 20 runs: 18-41.
    expect(cov.resultsFlushed, "no result ever reached the transport").toBeGreaterThan(8);
    // Measured over 20 runs: 33-65.
    expect(cov.staleResultDropped, "no cancelled reply's result was dropped").toBeGreaterThan(15);
    // Measured over 20 runs: 46-77.
    expect(cov.repliesCompleted, "no reply ever completed").toBeGreaterThan(25);
    // Measured over 20 runs: 4-16.
    expect(cov.stopWithBodyInFlight, "stop() never raced a held body").toBeGreaterThan(1);
  });

  // The property's first finding, shrunk: `replyStart, toolCalled, reset,
  // replyStart, toolCalled`. The reset aborts c1, whose cancelled result then
  // settled INTO the fresh conversation — c2 read it through `ctx.messages`,
  // and its `tool.completed` was logged after `session.reset`, where a resume
  // would rebuild it into the new conversation as well.
  test("a reset drops the result of a call it aborted, from the new conversation and the log", async () => {
    const seen: (readonly Message[])[] = [];
    const executeTool: ExecuteTool = (_name, _args, _sid, messages, options) => {
      seen.push(messages ?? []);
      if (options?.toolCallId !== "c1") return Promise.resolve("ok");
      // The real executor's contract: an abort settles the call with a result.
      return new Promise((resolve) => {
        options.signal?.addEventListener("abort", () => resolve("cancelled"), { once: true });
      });
    };
    const { core, sink } = makeCore({ executeTool, logger: silentLogger });
    await core.start();
    core.onReplyStarted("r1");
    core.report({ type: "tool.called", toolCallId: "c1", toolName: "lookup", args: {} });
    await drainImmediates();
    core.command({ type: "reset" });
    await drainImmediates();
    core.onReplyStarted("r2");
    core.report({ type: "tool.called", toolCallId: "c2", toolName: "lookup", args: {} });
    await drainImmediates();
    await core.stop();

    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual([]);
    const types = sink.events.map((e) => (e.type === "tool.completed" ? e.toolCallId : e.type));
    expect(types.slice(types.indexOf("session.reset"))).not.toContain("c1");
  });
});
