// Copyright 2026 the AAI authors. MIT license.

import { dialog, type SlotStore } from "@alexkroman1/aai";
import { createDetachedSlotStore } from "@alexkroman1/aai/host-internal";
import type { SessionEvent, SessionEventBody } from "@alexkroman1/aai/protocol";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { makeLogger } from "./_test-utils.ts";
import { openSessionDialogs } from "./runtime-dialogs.ts";
import { createSystemPromptResolver } from "./runtime-system-prompt.ts";
import type { Transport } from "./transports/types.ts";

const SID = "s-dialog";

/**
 * A claim flow with all three of the things this module wires: an instruction
 * per state, a deadline on the one the caller can stall in, and a SELF
 * transition on what counts as hearing them.
 *
 * The self transition is the shape the module doc calls a silence ladder — it
 * moves the dialog without moving the state path, which is exactly the case a
 * position comparison cannot see and the write count can.
 */
function claimDialog(key = "claim") {
  return dialog(key, {
    initial: "verifying",
    states: {
      verifying: {
        instruction: "Get the caller's policy number.",
        timeout: { afterMs: 5000, send: "GAVE_UP" },
        on: {
          VERIFIED: "quoting",
          GAVE_UP: "abandoned",
          "@user-transcript.committed": "verifying",
        },
      },
      quoting: {
        instruction: "Read the excess disclosure, then quote.",
        timeout: { afterMs: 9000, send: "GAVE_UP" },
        on: { QUOTED: "done", GAVE_UP: "abandoned" },
      },
      abandoned: { instruction: "Say goodbye.", final: true },
      done: { final: true },
    },
  });
}

/** A transport stub: the only method this module calls is the optional one. */
function makeTransport(): { transport: Transport; refreshes: () => number } {
  const refreshSystemPrompt = vi.fn();
  const transport: Transport = {
    start: async () => undefined,
    stop: async () => undefined,
    sendUserAudio: () => undefined,
    sendToolResult: () => undefined,
    cancelReply: () => undefined,
    refreshSystemPrompt,
  };
  return { transport, refreshes: () => refreshSystemPrompt.mock.calls.length };
}

let stamped = 0;
/** A session event as the emitter would hand it over: body plus envelope. */
function event(body: SessionEventBody): SessionEvent {
  stamped += 1;
  return { ...body, meta: { id: `evt_${stamped}`, at: stamped } } as SessionEvent;
}

const heard = (text: string) => event({ type: "user-transcript.committed", text });

/**
 * The handshake frame — the FIRST event of every session, and so what primes the
 * dialogs. No dialog here declares a transition on it, which is the point: it
 * arms the opening deadline without moving anything.
 */
const configured = () =>
  event({
    type: "session.configured",
    audioFormat: "pcm_s16le",
    sampleRate: 16_000,
    ttsSampleRate: 24_000,
  });

function setup(
  dialogs: Parameters<typeof openSessionDialogs>[0],
  opts?: { slots?: SlotStore; commit?: () => void },
) {
  const { transport, refreshes } = makeTransport();
  const logger = makeLogger();
  const slots = opts?.slots ?? createDetachedSlotStore();
  // The real resolver, not a stub: half of what this module promises is a
  // property OF that seam — an empty suffix has to hand back the base string
  // itself — and a stub would assert it of the stub.
  const prompts = createSystemPromptResolver({
    agentConfig: { name: "Support", systemPrompt: "Be brief." } as never,
    hasTools: false,
    toolGuidance: undefined,
  });
  const bound = openSessionDialogs(dialogs, SID, {
    prompt: prompts.forSession(),
    slots,
    transport: () => transport,
    logger,
    ...omitUndefined({ commit: opts?.commit }),
  });
  return { bound, slots, logger, refreshes, base: prompts.base() };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("an agent that declares no dialogs", () => {
  test("installs no suffix, so `resolve()` is the base string ITSELF", () => {
    const { bound, base } = setup(undefined);

    bound.observe(heard("hello"));

    // Identity, not equality: the seam short-circuits on an empty suffix, and
    // that is what keeps every shipped agent's prompt byte-identical.
    expect(bound.prompt.resolve()).toBe(base);
    expect(bound.turnKnobs).toBeUndefined();
  });
});

describe("session events reach a declared dialog", () => {
  test("the active state's instruction becomes the prompt suffix", () => {
    const claim = claimDialog();
    const { bound, slots, base } = setup([claim]);

    bound.observe(configured());

    const prompt = bound.prompt.resolve();
    expect(prompt.startsWith(base)).toBe(true);
    expect(prompt).toContain("Get the caller's policy number.");
    expect(claim.position({ slots, sessionId: SID }).state).toBe("verifying");
  });

  test("a state with no instruction contributes nothing, and the prompt is the base again", () => {
    const claim = claimDialog();
    const { bound, slots, base } = setup([claim]);
    bound.observe(configured());

    claim.send({ slots, sessionId: SID }, { type: "VERIFIED" });
    claim.send({ slots, sessionId: SID }, { type: "QUOTED" });

    expect(claim.position({ slots, sessionId: SID }).state).toBe("done");
    expect(bound.prompt.resolve()).toBe(base);
  });

  test("two dialogs concatenate in DECLARATION order", () => {
    const { bound } = setup([claimDialog("first"), claimDialog("second")]);

    bound.observe(configured());

    const prompt = bound.prompt.resolve();
    const lines = prompt.split("\n").filter((line) => line.startsWith("Get the caller's"));
    expect(lines).toHaveLength(2);
  });

  test("an event no state handles writes nothing and commits nothing", () => {
    const commit = vi.fn();
    const claim = claimDialog();
    const { bound } = setup([claim], { commit });

    // Two dozen transcript frames is a second of a real call, and none of them
    // is declared — the whole reason `receive` asks before it sends.
    for (let i = 0; i < 24; i += 1) bound.observe(event({ type: "speech.started" }));

    expect(commit).not.toHaveBeenCalled();
  });

  test("a declared transition moves the dialog and commits once", () => {
    const commit = vi.fn();
    const claim = claimDialog();
    const { bound, slots } = setup([claim], { commit });
    bound.observe(configured());

    bound.observe(heard("my policy is 400"));

    // The self transition: same state path, and it really moved.
    expect(claim.position({ slots, sessionId: SID }).state).toBe("verifying");
    expect(commit).toHaveBeenCalledTimes(1);
  });
});

describe("a dialog observes the SESSION, not its own transitions", () => {
  test("the `state.updated` a transition's own commit emits does not re-enter", () => {
    // The recursion this stops: a commit emits `state.updated`, which is a
    // session event, which this dialog declares a transition on. Without the
    // latch the send below never returns.
    const watcher = dialog("watcher", {
      initial: "watching",
      states: {
        watching: {
          instruction: "Watch.",
          on: { "@state.updated": "watching", DONE: "seen" },
        },
        seen: { final: true, instruction: "Seen." },
      },
    });
    let depth = 0;
    let maxDepth = 0;
    const commit = (): void => {
      depth += 1;
      maxDepth = Math.max(maxDepth, depth);
      bound.observe(event({ type: "state.updated", state: {} }));
      depth -= 1;
    };
    const { bound } = setup([watcher], { commit });

    bound.observe(event({ type: "state.updated", state: {} }));

    // One commit, from the one transition the outer event caused. The nested
    // event was recorded and sent by the emitter and offered to nobody.
    expect(maxDepth).toBe(1);
  });
});

describe("the prompt is pushed to the transport only when it CHANGED", () => {
  test("a move that changes the instruction refreshes; one that does not, does not", () => {
    const claim = claimDialog();
    const { bound, refreshes } = setup([claim]);
    bound.observe(configured());
    expect(refreshes()).toBe(0);

    // A self transition: the dialog moved, the instruction did not.
    bound.observe(heard("still here"));
    expect(refreshes()).toBe(0);

    // A deadline moves it to a state with different words.
    vi.advanceTimersByTime(5000);
    expect(refreshes()).toBe(1);
  });
});

describe("a per-state deadline", () => {
  test("fires the event the state declared, and moves the dialog", () => {
    const claim = claimDialog();
    const { bound, slots } = setup([claim]);
    bound.observe(configured());

    vi.advanceTimersByTime(4999);
    expect(claim.position({ slots, sessionId: SID }).state).toBe("verifying");
    vi.advanceTimersByTime(1);
    expect(claim.position({ slots, sessionId: SID }).state).toBe("abandoned");
  });

  test("is RE-ARMED by a move, including a self transition", () => {
    const claim = claimDialog();
    const { bound, slots } = setup([claim]);
    bound.observe(configured());

    // The caller keeps talking: each committed utterance restarts the window,
    // which is what makes this deadline mean "since we last heard anything".
    for (let i = 0; i < 4; i += 1) {
      vi.advanceTimersByTime(4000);
      bound.observe(heard(`turn ${i}`));
    }
    expect(claim.position({ slots, sessionId: SID }).state).toBe("verifying");

    vi.advanceTimersByTime(5000);
    expect(claim.position({ slots, sessionId: SID }).state).toBe("abandoned");
  });

  test("is re-armed on the state a fired deadline moved INTO", () => {
    const ladder = dialog("ladder", {
      initial: "first",
      states: {
        first: {
          instruction: "One.",
          timeout: { afterMs: 1000, send: "UP" },
          on: { UP: "second" },
        },
        second: {
          instruction: "Two.",
          timeout: { afterMs: 1000, send: "UP" },
          on: { UP: "third" },
        },
        third: { instruction: "Three.", final: true },
      },
    });
    const { bound, slots } = setup([ladder]);
    bound.observe(configured());

    vi.advanceTimersByTime(1000);
    expect(ladder.position({ slots, sessionId: SID }).state).toBe("second");
    // The second rung, armed by the first rung firing rather than by any event.
    vi.advanceTimersByTime(1000);
    expect(ladder.position({ slots, sessionId: SID }).state).toBe("third");
  });

  test("does not fire when a TOOL moved the dialog out of the state it was armed for", () => {
    const claim = claimDialog();
    const { bound, slots } = setup([claim]);
    bound.observe(configured());

    // A gated tool writes through the executor's own view, so nothing here sees
    // it — which is the whole reason the armed state is recorded.
    claim.send({ slots, sessionId: SID }, { type: "VERIFIED" });
    vi.advanceTimersByTime(5000);

    expect(claim.position({ slots, sessionId: SID }).state).toBe("quoting");
  });

  test("is DISARMED by stop(), so nothing is left holding the event loop", () => {
    const claim = claimDialog();
    const { bound, slots } = setup([claim]);
    bound.observe(configured());

    bound.stop();
    vi.advanceTimersByTime(60_000);

    expect(vi.getTimerCount()).toBe(0);
    expect(claim.position({ slots, sessionId: SID }).state).toBe("verifying");
  });

  test("is armed on the FIRST event rather than at attach, so a resume's hydrate wins", () => {
    const claim = claimDialog();
    const { bound, slots } = setup([claim]);

    // Nothing is armed and nothing is materialized until an event arrives: a
    // resume's stored position lands inside `core.start()`, after this is built.
    expect(vi.getTimerCount()).toBe(0);
    claim.send({ slots, sessionId: SID }, { type: "VERIFIED" });

    bound.observe(configured());

    expect(bound.prompt.resolve()).toContain("Read the excess disclosure");
    vi.advanceTimersByTime(9000);
    expect(claim.position({ slots, sessionId: SID }).state).toBe("abandoned");
  });
});

describe("a dialog that throws", () => {
  test("is logged and does not stop the next one from seeing the event", () => {
    const broken = claimDialog("broken");
    const working = claimDialog("working");
    vi.spyOn(broken, "receive").mockImplementation(() => {
      throw new Error("machine exploded");
    });
    const { bound, slots, logger } = setup([broken, working]);
    bound.observe(configured());

    bound.observe(heard("my policy is 400"));

    expect(logger.warn).toHaveBeenCalledWith(
      "Dialog step failed",
      expect.objectContaining({ dialog: "broken", step: "receive" }),
    );
    expect(working.position({ slots, sessionId: SID }).state).toBe("verifying");
  });
});
