// Copyright 2026 the AAI authors. MIT license.
/**
 * The three pieces of `AgentDef.lowConfidence` that need a session, driven
 * directly rather than through the transport.
 *
 * The policy's own bands are the SDK's (`sdk/low-confidence.test.ts`) and the
 * wiring into a turn is `pipeline-user-speech.test.ts`; what is here is what
 * this module decides on its own — which collaborators each verdict touches,
 * what the model's copy says, and what a clarification does and does not do.
 */

import { resolveLowConfidence } from "@alexkroman1/aai/host-internal";
import { describe, expect, test, vi } from "vitest";
import { silentLogger } from "../_test-utils.ts";
import {
  createClarificationSpeaker,
  createLowConfidenceGate,
  modelTranscript,
} from "./pipeline-low-confidence.ts";

function makeGate(policy: Parameters<typeof resolveLowConfidence>[0] | undefined): {
  gate: ReturnType<typeof createLowConfidenceGate>;
  calls: { retired: number; cleared: number; ended: number; spoken: string[] };
} {
  const calls = { retired: 0, cleared: 0, ended: 0, spoken: [] as string[] };
  const gate = createLowConfidenceGate({
    policy: policy === undefined ? undefined : resolveLowConfidence(policy),
    log: silentLogger,
    sid: "s1",
    retireSpeculation: () => {
      calls.retired += 1;
    },
    clearRecovery: () => {
      calls.cleared += 1;
    },
    endSpeech: () => {
      calls.ended += 1;
    },
    speakClarification: (text) => calls.spoken.push(text),
  });
  return { gate, calls };
}

describe("createLowConfidenceGate", () => {
  test("an agent that declares no policy gets NO gate", () => {
    // `undefined` is what the handler reads as "commit every final", and it
    // costs the session not even a closure call per turn.
    expect(makeGate(undefined).gate).toBeUndefined();
  });

  test("a confident turn touches nothing", () => {
    const { gate, calls } = makeGate({});
    expect(gate?.classify("cancel my order", { transcriptConfidence: 0.9 })).toBeUndefined();
    expect(calls).toEqual({ retired: 0, cleared: 0, ended: 0, spoken: [] });
  });

  test("a discard retires the speculation and speaks nothing", () => {
    // No `clearRecovery` and no `endSpeech`: a transcript nobody could make
    // out is the same event as a barge-in that commits nothing, so the
    // false-interruption machinery must still see it that way.
    const { gate, calls } = makeGate({});
    expect(gate?.classify("shhk", { transcriptConfidence: 0.05 })).toBe("handled");
    expect(calls).toEqual({ retired: 1, cleared: 0, ended: 0, spoken: [] });
  });

  test("a clarification takes the floor, so it clears the armed resume", () => {
    const { gate, calls } = makeGate({ phrase: "Say that again?" });
    expect(gate?.classify("order double you", { transcriptConfidence: 0.3 })).toBe("handled");
    expect(calls).toEqual({ retired: 1, cleared: 1, ended: 1, spoken: ["Say that again?"] });
  });

  test("an empty phrase drops the turn without taking the floor", () => {
    const { gate, calls } = makeGate({ phrase: "" });
    expect(gate?.classify("order double you", { transcriptConfidence: 0.3 })).toBe("handled");
    expect(calls).toEqual({ retired: 1, cleared: 0, ended: 0, spoken: [] });
  });

  test("a note runs the turn and touches nothing", () => {
    const { gate, calls } = makeGate({ action: "note", note: "check the id" });
    expect(gate?.classify("cancel W123", { transcriptConfidence: 0.3 })).toEqual({
      note: "check the id",
    });
    expect(calls).toEqual({ retired: 0, cleared: 0, ended: 0, spoken: [] });
  });

  test("the statistic it reads is the one the policy names", () => {
    const mean = makeGate({});
    const min = makeGate({ statistic: "minWord" });
    const meta = { transcriptConfidence: 0.95, minWordConfidence: 0.3 };
    expect(mean.gate?.classify("cancel W123", meta)).toBeUndefined();
    expect(min.gate?.classify("cancel W123", meta)).toBe("handled");
  });
});

describe("modelTranscript", () => {
  test("plain text passes through by IDENTITY when there is nothing to add", () => {
    const text = "cancel my order";
    expect(modelTranscript(text, undefined)).toBe(text);
  });

  test("a spelled run is appended", () => {
    expect(modelTranscript("it is Y, U, S, U, F", undefined)).toBe(
      "it is Y, U, S, U, F\n[spelled aloud: yusuf]",
    );
  });

  test("a note is appended", () => {
    expect(modelTranscript("cancel W123", "may be mis-heard")).toBe(
      "cancel W123\n[may be mis-heard]",
    );
  });

  test("both compose, spelling first", () => {
    // Order matters only for reading: the spelling is about the words, the
    // note is about our confidence in them.
    expect(modelTranscript("it is Y, U, S, U, F", "may be mis-heard")).toBe(
      "it is Y, U, S, U, F\n[spelled aloud: yusuf]\n[may be mis-heard]",
    );
  });
});

describe("createClarificationSpeaker", () => {
  test("chains a reply that reports a recovery transcript and speaks it", async () => {
    const report = vi.fn();
    const sendTtsText = vi.fn();
    const chained: Promise<void>[] = [];
    const speak = createClarificationSpeaker({
      chain: (run) => chained.push(run()),
      runReply: async (idPrefix, body) => {
        expect(idPrefix).toBe("pipeline-clarify");
        expect(await body()).toBe(true);
      },
      callbacks: { report },
      sendTtsText,
      onCrash: () => expect.unreachable("the body must not throw"),
    });

    speak("Could you repeat that?");
    await Promise.all(chained);

    // Tagged, because a recovery utterance is SPOKEN and never RECORDED —
    // `AgentTranscriptRecovery` is the only thing on the wire that says so.
    expect(report).toHaveBeenCalledWith({
      type: "agent-transcript.committed",
      text: "Could you repeat that?",
      recovery: "low-confidence",
    });
    // `publishTranscript: false`: the committed report above is the caption.
    expect(sendTtsText).toHaveBeenCalledWith("Could you repeat that?", {
      publishTranscript: false,
    });
  });

  test("a crashing reply reaches onCrash rather than the caller", async () => {
    const onCrash = vi.fn();
    const chained: Promise<void>[] = [];
    const speak = createClarificationSpeaker({
      chain: (run) => chained.push(run()),
      runReply: () => Promise.reject(new Error("boom")),
      callbacks: { report: vi.fn() },
      sendTtsText: vi.fn(),
      onCrash,
    });
    speak("hello");
    await Promise.all(chained);
    expect(onCrash).toHaveBeenCalledOnce();
  });
});
