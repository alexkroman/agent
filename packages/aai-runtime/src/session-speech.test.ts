// Copyright 2026 the AAI authors. MIT license.
// The session half of `speech.say`/`interrupt` over a scripted transport: what
// reaches the transport, what `done` settles when it cannot, and that
// `interrupt()` is the client's cancel and nothing else.

import { describe, expect, test, vi } from "vitest";
import { makeLogger } from "./_test-utils.ts";
import { createSpeechVerbs, type SpeechVerbs, speechDirectory } from "./session-speech.ts";
import type { SpokenLine, SpokenLineOutcome, Transport } from "./transports/types.ts";

/** A transport with the two speech verbs scripted, and every other verb inert. */
function transport(overrides: Partial<Transport> = {}): Transport {
  return {
    start: async () => undefined,
    stop: async () => undefined,
    sendUserAudio: () => undefined,
    sendToolResult: () => undefined,
    cancelReply: () => undefined,
    ...overrides,
  };
}

/** A `speakLine` that holds each line until the spec settles it. */
function heldSpeakLine() {
  const lines: { text: string; line: SpokenLine; settle: (o: SpokenLineOutcome) => void }[] = [];
  const speakLine = vi.fn(
    (text: string, line: SpokenLine) =>
      new Promise<SpokenLineOutcome>((settle) => {
        lines.push({ text, line, settle });
      }),
  );
  return { speakLine, lines };
}

function verbs(t: Transport, state: { stopped?: boolean } = {}) {
  const log = makeLogger();
  const cancel = vi.fn();
  const speech = createSpeechVerbs({
    sid: "s-1",
    transport: t,
    log,
    stopped: () => state.stopped === true,
    cancel,
  });
  return { speech, cancel, log };
}

describe("say", () => {
  test("hands the trimmed text to the transport and settles with its outcome", async () => {
    const held = heldSpeakLine();
    const { speech } = verbs(transport({ speakLine: held.speakLine }));
    const handle = speech.say("  Your timer is done.  ");

    expect(held.lines.map((l) => l.text)).toEqual(["Your timer is done."]);
    held.lines[0]?.settle("played");
    await expect(handle.done).resolves.toBe("played");
  });

  test("an S2S transport settles UNSUPPORTED, and says why once per session", async () => {
    const { speech, log } = verbs(transport());
    await expect(speech.say("one").done).resolves.toBe("unsupported");
    await expect(speech.say("two").done).resolves.toBe("unsupported");
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  test("blank text and a stopped session settle DROPPED without reaching the transport", async () => {
    const held = heldSpeakLine();
    const state = { stopped: false };
    const { speech } = verbs(transport({ speakLine: held.speakLine }), state);
    await expect(speech.say("   ").done).resolves.toBe("dropped");
    state.stopped = true;
    await expect(speech.say("Hello.").done).resolves.toBe("dropped");
    expect(held.speakLine).not.toHaveBeenCalled();
  });

  test("a transport that breaks the never-rejects contract still settles DROPPED", async () => {
    const { speech } = verbs(
      transport({ speakLine: () => Promise.reject(new Error("socket gone")) }),
    );
    await expect(speech.say("Hello.").done).resolves.toBe("dropped");
  });

  test("{ interrupt: true } cuts the agent BEFORE the line is queued", () => {
    const order: string[] = [];
    const { speech, cancel } = verbs(
      transport({
        isReplying: () => true,
        speakLine: (text) => {
          order.push(`speak:${text}`);
          return Promise.resolve("played");
        },
      }),
    );
    cancel.mockImplementation(() => order.push("cancel"));
    speech.say("Now.", { interrupt: true });
    expect(order).toEqual(["cancel", "speak:Now."]);
  });

  test("the handle takes back a QUEUED line through its signal, without cutting anything", () => {
    const held = heldSpeakLine();
    const { speech, cancel } = verbs(transport({ speakLine: held.speakLine }));
    const handle = speech.say("Later.");
    handle.interrupt();
    expect(held.lines[0]?.line.signal.aborted).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
  });

  test("the handle cuts a PLAYING line with the session's interrupt", () => {
    const held = heldSpeakLine();
    const { speech, cancel } = verbs(transport({ speakLine: held.speakLine }));
    const handle = speech.say("Now playing.");
    held.lines[0]?.line.onStart();
    handle.interrupt();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(held.lines[0]?.line.signal.aborted).toBe(false);
  });

  test("the handle is inert once the line has settled", async () => {
    const held = heldSpeakLine();
    const { speech, cancel } = verbs(transport({ speakLine: held.speakLine }));
    const handle = speech.say("Done.");
    held.lines[0]?.line.onStart();
    held.lines[0]?.settle("played");
    await handle.done;
    handle.interrupt();
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("interrupt", () => {
  test("is the client cancel while the agent is replying", () => {
    const { speech, cancel } = verbs(transport({ isReplying: () => true }));
    expect(speech.interrupt()).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("answers false, and cancels nothing, while the agent is silent", () => {
    const { speech, cancel } = verbs(transport({ isReplying: () => false }));
    expect(speech.interrupt()).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
  });

  test("a transport that cannot tell (S2S) is interrupted blind", () => {
    const { speech, cancel } = verbs(transport());
    expect(speech.interrupt()).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("answers false once the session has stopped", () => {
    const { speech, cancel } = verbs(transport({ isReplying: () => true }), { stopped: true });
    expect(speech.interrupt()).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("speechDirectory", () => {
  function session(): SpeechVerbs & { announce: (instruction: string) => boolean } {
    return {
      say: vi.fn(() => ({ done: Promise.resolve("played" as const), interrupt: vi.fn() })),
      interrupt: vi.fn(() => true),
      announce: vi.fn(() => true),
    };
  }

  test("live() is undefined for an id no live session holds", () => {
    const directory = speechDirectory(new Map());
    expect(directory.live("gone")).toBeUndefined();
  });

  test("of() resolves the session at each CALL, so it follows a resume", () => {
    const sessions = new Map<string, ReturnType<typeof session>>();
    const directory = speechDirectory(sessions);
    const speech = directory.of("s-1");
    const first = session();
    const resumed = session();

    sessions.set("s-1", first);
    speech.say("One.");
    sessions.set("s-1", resumed);
    speech.say("Two.");

    expect(first.say).toHaveBeenCalledWith("One.", undefined);
    expect(resumed.say).toHaveBeenCalledWith("Two.", undefined);
  });

  test("an ended session answers as a stopped one: DROPPED, and interrupt false", async () => {
    const directory = speechDirectory(new Map());
    const speech = directory.of("gone");
    await expect(speech.say("Hello?").done).resolves.toBe("dropped");
    expect(speech.interrupt()).toBe(false);
    expect(directory.announce("gone", "Tell them.")).toBe(false);
  });
});
