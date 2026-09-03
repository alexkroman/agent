// Copyright 2026 the AAI authors. MIT license.
/**
 * The latch that turns a resume CLAIM into a resume FACT, and the two lookups
 * that write into it.
 *
 * What is worth testing here is not the three lines of the latch — it is that
 * each lookup records only when it really recovered something, because the whole
 * value of the mechanism is the EMPTY case: an id that names nothing must fall
 * through to a greeting rather than producing a connected, silent agent.
 */

import type { SessionEvent } from "@alexkroman1/aai/protocol";
import { describe, expect, test, vi } from "vitest";
import { makeMockCore } from "./_test-utils.ts";
import { attachSessionStream } from "./runtime-session-stream.ts";
import type { SessionEventStream } from "./session-event-stream.ts";
import { createResumeFindings } from "./session-resume-found.ts";

describe("createResumeFindings", () => {
  test("starts empty, latches on the first record, and cannot be un-said", () => {
    const findings = createResumeFindings();
    expect(findings.any()).toBe(false);
    findings.record();
    expect(findings.any()).toBe(true);
    // Monotonic on purpose: history and slot state are INDEPENDENT sources, and
    // either one is sufficient evidence that the id named a real session. A
    // second source finding nothing must not retract the first.
    findings.record();
    expect(findings.any()).toBe(true);
  });
});

/**
 * A stream holding exactly these events for every session.
 *
 * Every member is implemented rather than cast past: the contract is nine
 * members, and a `as unknown as SessionEventStream` would keep compiling after
 * one is ADDED — which for a fake standing in for the log is the exact moment it
 * stops being a valid double.
 */
function streamOf(events: SessionEvent[]): SessionEventStream {
  return {
    append: vi.fn((_sid: string, body) => ({ ...body, index: 0 }) as SessionEvent),
    tail: vi.fn(() => events.length),
    read: vi.fn(() => Promise.resolve({ events, tail: events.length })),
    flush: vi.fn(() => Promise.resolve()),
    hydrate: vi.fn(() => Promise.resolve()),
    discard: vi.fn(),
    clear: vi.fn(),
    durable: false,
  };
}

/**
 * A core whose `start` resolves, recording whether history was restored.
 *
 * `makeMockCore` is the package's own seam for this, which matters beyond the
 * cast it saves: `attachSessionStream` wraps BOTH bookends, so a hand-rolled
 * fake missing `stop` fails on `core.stop.bind` at attach time rather than in
 * the assertion — which is how this file was first written.
 */
function coreWith() {
  const restoreHistory = vi.fn();
  return { core: makeMockCore({ restoreHistory }), restoreHistory };
}

const USER_TURN: SessionEvent = {
  type: "user-transcript.committed",
  text: "two large pepperoni",
} as SessionEvent;

describe("attachSessionStream reports what it restored", () => {
  test("a resume that restored a conversation records a finding", async () => {
    const findings = createResumeFindings();
    const { core, restoreHistory } = coreWith();
    attachSessionStream(core, {
      stream: streamOf([USER_TURN]),
      sessionId: "sess-1",
      resumed: true,
      findings,
    });
    await core.start();
    expect(restoreHistory).toHaveBeenCalledOnce();
    expect(findings.any()).toBe(true);
  });

  test("a resume whose log is EMPTY records nothing — this is the greeting case", async () => {
    // The id was well-formed and named nothing: a reload past the resume grace,
    // or a guest that self-exited on idle. Suppressing the greeting here is what
    // produced a session that was connected and mute.
    const findings = createResumeFindings();
    const { core, restoreHistory } = coreWith();
    attachSessionStream(core, {
      stream: streamOf([]),
      sessionId: "sess-gone",
      resumed: true,
      findings,
    });
    await core.start();
    expect(restoreHistory).not.toHaveBeenCalled();
    expect(findings.any()).toBe(false);
  });

  test("a FRESH session reads no log at all, and records nothing", async () => {
    // Not a resume, so there is nothing to look up — and a fresh session greets
    // for the ordinary reason, not because of this latch.
    const findings = createResumeFindings();
    const stream = streamOf([USER_TURN]);
    const { core, restoreHistory } = coreWith();
    attachSessionStream(core, { stream, sessionId: "sess-new", resumed: false, findings });
    await core.start();
    expect(stream.read).not.toHaveBeenCalled();
    expect(restoreHistory).not.toHaveBeenCalled();
    expect(findings.any()).toBe(false);
  });

  test("the findings latch is optional — the sandbox path passes none", async () => {
    const { core } = coreWith();
    attachSessionStream(core, {
      stream: streamOf([USER_TURN]),
      sessionId: "sess-1",
      resumed: true,
    });
    await expect(core.start()).resolves.toBeUndefined();
  });
});
