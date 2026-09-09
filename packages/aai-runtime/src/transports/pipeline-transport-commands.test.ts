// Copyright 2026 the AAI authors. MIT license.
// The client-facing VERBS of the pipeline transport. Nothing here owns state:
// each command ROUTES to the collaborator that owns what it touches, so what a
// spec can claim about this module is exactly the routing — which collaborators
// a verb reaches, in what ORDER where the order is load-bearing, and which
// verbs go quiet after teardown. Two of those are silent when they regress: a
// cancel that forgets `recovery.clear()` resumes a reply the caller deliberately
// stopped, and a reset that bumps the gate too late strands its own greeting.

import type { Message } from "@alexkroman1/aai";
import { createEpoch } from "@alexkroman1/aai/internal";
import { describe, expect, test, vi } from "vitest";
import type { HeardTracker } from "./pipeline-heard.ts";
import type { PipelineHistory } from "./pipeline-history.ts";
import type { PipelineProviderSessions } from "./pipeline-providers.ts";
import type { SpeculationController } from "./pipeline-speculation.ts";
import { createPipelineCommands, type PipelineCommandDeps } from "./pipeline-transport-commands.ts";
import type { TurnGate } from "./pipeline-turn-gate.ts";

/** One command's whole world, with every call recorded in order. */
function harness(overrides: { terminated?: boolean } = {}) {
  const calls: string[] = [];
  /** Record the call, in the one order every assertion below reads. */
  const note =
    (name: string) =>
    (...args: unknown[]): void => {
      calls.push(args.length > 0 ? `${name}(${args.map(String).join(",")})` : name);
    };

  const sendAudio = vi.fn<(pcm: Int16Array) => void>();
  const stt = {
    sendAudio,
    on: vi.fn(() => () => undefined),
    close: () => Promise.resolve(),
  };
  const providers: PipelineProviderSessions = {
    stt,
    tts: null,
    open: () => Promise.resolve("ok"),
    unsubscribe: vi.fn(),
    close: () => Promise.resolve(),
  };

  const seeded: (readonly Message[])[] = [];
  const history: PipelineHistory = {
    conversation: [],
    llm: [],
    pushConversation: note("history.pushConversation"),
    pushToolResult: note("history.pushToolResult"),
    pushLlm: note("history.pushLlm"),
    dropTrailingUser: note("history.dropTrailingUser"),
    seed: (msgs) => {
      calls.push("history.seed");
      seeded.push(msgs);
    },
    reset: note("history.reset"),
    revision: createEpoch(),
  };

  const heard: HeardTracker = {
    onText: () => "",
    onAudio: note("heard.onAudio"),
    onClientPlaybackReport: note("heard.onClientPlaybackReport"),
    onWords: note("heard.onWords"),
    startReply: note("heard.startReply"),
    pending: () => false,
    cut: note("heard.cut"),
    heard: () => ({ chars: 0, recordableChars: 0, text: "" }),
    resumePrompt: () => undefined,
  };

  const gate: TurnGate = {
    queueEpoch: () => 0,
    historyEpoch: () => 0,
    queueCurrent: () => true,
    historyCurrent: () => true,
    invalidateQueued: note("gate.invalidateQueued"),
    invalidateAll: note("gate.invalidateAll"),
  };

  const speculation: SpeculationController = {
    onPartial: note("speculation.onPartial"),
    onFinal: note("speculation.onFinal"),
    onUtteranceIdle: note("speculation.onUtteranceIdle"),
    take: () => null,
    discard: note("speculation.discard"),
  };

  const deps: PipelineCommandDeps = {
    lifecycle: {
      start: () => {
        calls.push("lifecycle.start");
        return Promise.resolve();
      },
      stop: () => {
        calls.push("lifecycle.stop");
        return Promise.resolve();
      },
      audioReady: () => true,
      greet: note("lifecycle.greet"),
    },
    providers: () => providers,
    history,
    heard,
    gate,
    recovery: { clear: note("recovery.clear"), onUserTurn: note("recovery.onUserTurn") },
    speechEdges: { reset: note("speechEdges.reset") },
    nudger: { arm: note("nudger.arm"), onUserSpeech: note("nudger.onUserSpeech") },
    speculation,
    abortInFlightTurn: note("abortInFlightTurn"),
    runChainedTurn: (text, label, kind) => {
      calls.push(`runChainedTurn(${text}|${label}|${JSON.stringify(kind)})`);
    },
    isTerminated: () => overrides.terminated === true,
  };

  const transport = createPipelineCommands(deps);
  // `injectTurn`, `seedHistory`, `reset` and `onPlaybackProgress` are OPTIONAL
  // on `Transport` (an s2s transport implements neither of the last two), and
  // this module defines all four. Narrowed once here so every case below calls
  // them unconditionally — a `?.` in each test would pass just as happily
  // against a transport that had stopped defining one.
  const { injectTurn, seedHistory, reset, onPlaybackProgress } = transport;
  if (!(injectTurn && seedHistory && reset && onPlaybackProgress)) {
    throw new Error("createPipelineCommands must define every optional Transport verb");
  }
  return {
    transport,
    verbs: { injectTurn, seedHistory, reset, onPlaybackProgress },
    calls,
    seeded,
    sendAudio,
    deps,
  };
}

describe("createPipelineCommands", () => {
  test("start and stop are the lifecycle's, unwrapped", async () => {
    const { transport, calls } = harness();
    await transport.start();
    await transport.stop();
    expect(calls).toEqual(["lifecycle.start", "lifecycle.stop"]);
  });

  test("sendUserAudio converts bytes to PCM16 and hands them to the STT session", () => {
    const { transport, sendAudio } = harness();
    // 0x0100 0x0302 little-endian → 256, 770.
    transport.sendUserAudio(new Uint8Array([0, 1, 2, 3]));
    expect(sendAudio).toHaveBeenCalledTimes(1);
    expect(Array.from(sendAudio.mock.calls[0]?.[0] ?? [])).toEqual([256, 770]);
  });

  test("sendToolResult is a deliberate NO-OP in pipeline mode", () => {
    // Tool execution stays inside toVercelTools/streamText; a result is handed
    // back to the model there and never routed through the transport. It must
    // still be present and still not throw — the session core calls it.
    const { transport, calls } = harness();
    expect(() => transport.sendToolResult("call_1", "ok")).not.toThrow();
    expect(calls).toEqual([]);
  });

  test("cancelReply clears the resume budget, strands the QUEUE only, and re-arms the nudge", () => {
    // Three separate claims, all of which have shipped wrong somewhere: a
    // client-initiated cancel is INTENTIONAL, so it must never be resumed from;
    // it strands turns queued behind the cancelled one but leaves the
    // conversation valid, so `invalidateQueued` and not `invalidateAll`; and
    // silence after it should still nudge.
    const { transport, calls } = harness();
    transport.cancelReply();
    expect(calls).toEqual([
      "recovery.clear",
      "gate.invalidateQueued",
      "speculation.discard(reset)",
      "abortInFlightTurn",
      "nudger.arm",
    ]);
    expect(calls).not.toContain("gate.invalidateAll");
  });

  test("cancelReply reports no `reply.cancelled` of its own", () => {
    // The session's own `cancel` command calls `client.cancelled()`; barge-in
    // fires `onCancelled` where the cancel originates. A third report here
    // would double it.
    const { transport, calls } = harness();
    transport.cancelReply();
    expect(calls.some((call) => call.includes("cancelled"))).toBe(false);
  });

  test("injectTurn goes on the turn CHAIN, marked synthetic", () => {
    // The same path the silence nudge takes: it waits behind a reply in flight
    // rather than talking over one, and `synthetic` keeps the instruction out
    // of the user transcript while leaving it in the LLM's history.
    const { verbs, calls } = harness();
    verbs.injectTurn("the caller has been waiting");
    expect(calls).toEqual([
      'runChainedTurn(the caller has been waiting|Pipeline injected turn crashed|{"synthetic":true})',
    ]);
  });

  test("seedHistory hands the client's resent conversation straight to history", () => {
    // A reconnect resends what the browser held; both views are restored so the
    // resumed agent keeps memory of the prior conversation. The list is passed
    // through, not copied or filtered here.
    const { verbs, calls, seeded } = harness();
    const messages: Message[] = [{ role: "user", content: "earlier" }];
    verbs.seedHistory(messages);
    expect(calls).toEqual(["history.seed"]);
    expect(seeded).toEqual([messages]);
  });

  test("onPlaybackProgress is the one closed-loop input to the playback estimate", () => {
    const { verbs, calls } = harness();
    verbs.onPlaybackProgress(120);
    expect(calls).toEqual(["heard.onClientPlaybackReport(120)"]);
  });

  test("reset bumps the gate FIRST, and greets LAST", () => {
    // Both ends are ordering bugs with no symptom until they bite. The bump
    // goes before the abort so the aborted turn's deferred persistence and any
    // queued turns see the change; the greeting goes after it so the greeting
    // turn's epoch is the FRESH one and the strand does not catch it.
    const { verbs, calls } = harness();
    verbs.reset();
    expect(calls).toEqual([
      "gate.invalidateAll",
      "recovery.onUserTurn",
      "speechEdges.reset",
      "speculation.discard(reset)",
      "abortInFlightTurn",
      "history.reset",
      "nudger.onUserSpeech",
      "lifecycle.greet",
    ]);
  });

  test("reset counts as user activity on BOTH budgets", () => {
    // A reset restores the false-interruption resume budget and restarts the
    // silence window — it is a person doing something, not a timeout.
    const { verbs, calls } = harness();
    verbs.reset();
    expect(calls).toContain("recovery.onUserTurn");
    expect(calls).toContain("nudger.onUserSpeech");
  });
});

describe("after teardown", () => {
  test("the verbs that touch a gone session go quiet, and the others still run", () => {
    // `isTerminated` guards audio, cancel, inject and playback reports — each
    // reaches a collaborator that belongs to a session which no longer exists.
    // `seedHistory` and `reset` deliberately do not consult it.
    const { transport, verbs, calls, sendAudio } = harness({ terminated: true });
    transport.sendUserAudio(new Uint8Array([0, 1]));
    transport.cancelReply();
    verbs.injectTurn("hello?");
    verbs.onPlaybackProgress(50);
    expect(sendAudio).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  test("audio is also dropped before the audio path is ready", () => {
    // Two conditions, not one: a live session whose TTS/STT pair has not been
    // adopted yet has nothing to hand the bytes to.
    const { transport, sendAudio, deps } = harness();
    deps.lifecycle.audioReady = () => false;
    transport.sendUserAudio(new Uint8Array([0, 1]));
    expect(sendAudio).not.toHaveBeenCalled();
  });

  test("a session with no adopted STT drops audio rather than throwing", () => {
    const { transport, deps } = harness();
    const withoutStt: PipelineProviderSessions = { ...deps.providers(), stt: null };
    deps.providers = () => withoutStt;
    expect(() => transport.sendUserAudio(new Uint8Array([0, 1]))).not.toThrow();
  });
});
