// Copyright 2026 the AAI authors. MIT license.
/**
 * Unit specs for the S2S connection's lifecycle statechart.
 *
 * Exercised through injected effects with no socket anywhere, which is the
 * point of splitting it out: `s2s-transport.test.ts` asserts the same rules
 * end-to-end through `connectS2s` and a fake WebSocket, and every one of those
 * specs has to build a connection before it can describe an ordering. Here a
 * phase is one `send` away, so the cases nobody wrote before — what a `STOP`
 * mid-resume does, what a trailing close does — are cheap to state.
 */

import { S2S_MAX_RESUME_ATTEMPTS } from "@alexkroman1/aai/host-internal";
import { describe, expect, test, vi } from "vitest";
import { createS2sLifecycle, type S2sLifecycleEffects } from "./s2s-lifecycle.ts";

/**
 * A lifecycle over spied effects.
 *
 * `satisfies` rather than a cast: it checks the shape against the real effects
 * type while keeping each field's `Mock` type, so `spies.reportFatal.mock.calls`
 * stays typed AND a field whose signature drifts is a compile error here. The
 * two `as unknown as` casts this replaced are exactly the ones that stop
 * reporting the moment a field is ADDED to the type they stand in for.
 *
 * `resume` never settles by default: a resume that resolved or rejected on its
 * own would decide half the orderings below before the spec got to them.
 */
function makeLifecycle(overrides: Partial<S2sLifecycleEffects> = {}) {
  const spies = {
    resume: vi.fn((_sessionId: string) => new Promise<void>(() => undefined)),
    dropLink: vi.fn(),
    closeHandle: vi.fn(),
    reportFatal: vi.fn((_detail: string) => undefined),
    cancelInFlightReply: vi.fn(),
    flushPendingToolResults: vi.fn(),
    currentReplyId: vi.fn((): string | null => null),
    log: vi.fn(
      (_level: "info" | "warn", _message: string, _fields?: Record<string, unknown>) => undefined,
    ),
  } satisfies S2sLifecycleEffects;
  const effects: S2sLifecycleEffects = { ...spies, ...overrides };
  return { spies, lifecycle: createS2sLifecycle(effects) };
}

/** A transient close — the kind worth a `session.resume`. */
const DROP = { type: "CLOSED", code: 1006, reason: "abnormal", transient: true } as const;
/** A protocol verdict — never resumable. */
const REJECT = { type: "CLOSED", code: 1008, reason: "unauthorized", transient: false } as const;

describe("createS2sLifecycle", () => {
  test("starts connecting and reaches live on the first session.ready", () => {
    const { spies, lifecycle } = makeLifecycle();
    expect(lifecycle.phase()).toBe("connecting");

    lifecycle.send({ type: "READY", sessionId: "s1" });

    expect(lifecycle.phase()).toBe("live");
    expect(lifecycle.sessionId()).toBe("s1");
    expect(spies.flushPendingToolResults).toHaveBeenCalledTimes(1);
  });

  test("a transient drop on a named session resumes it", () => {
    const { spies, lifecycle } = makeLifecycle();
    lifecycle.send({ type: "READY", sessionId: "s1" });

    lifecycle.send(DROP);

    expect(lifecycle.phase()).toBe("resuming");
    expect(spies.resume).toHaveBeenCalledWith("s1");
    // The turn the dead socket was serving is unblocked, not left hanging.
    expect(spies.cancelInFlightReply).toHaveBeenCalledTimes(1);
    expect(spies.reportFatal).not.toHaveBeenCalled();
  });

  test("a transient drop before any session.ready ends the session", () => {
    const { spies, lifecycle } = makeLifecycle();

    lifecycle.send(DROP);

    // Nothing to resume: the provider never named a session.
    expect(lifecycle.phase()).toBe("ended");
    expect(spies.resume).not.toHaveBeenCalled();
    expect(spies.reportFatal).toHaveBeenCalledTimes(1);
  });

  test("a fatal close code is never resumed", () => {
    const { spies, lifecycle } = makeLifecycle();
    lifecycle.send({ type: "READY", sessionId: "s1" });

    lifecycle.send(REJECT);

    expect(lifecycle.phase()).toBe("ended");
    expect(spies.resume).not.toHaveBeenCalled();
    expect(spies.dropLink).toHaveBeenCalledTimes(1);
    expect(spies.reportFatal).toHaveBeenCalledTimes(1);
  });

  test("a resumed session goes back to live", () => {
    const { spies, lifecycle } = makeLifecycle();
    lifecycle.send({ type: "READY", sessionId: "s1" });
    lifecycle.send(DROP);

    lifecycle.send({ type: "READY", sessionId: "s2" });

    expect(lifecycle.phase()).toBe("live");
    expect(lifecycle.sessionId()).toBe("s2");
    expect(spies.reportFatal).not.toHaveBeenCalled();
  });

  test("a close during the resume reports the failure exactly once", () => {
    const { spies, lifecycle } = makeLifecycle();
    lifecycle.send({ type: "READY", sessionId: "s1" });
    lifecycle.send(DROP);

    lifecycle.send(DROP);

    expect(lifecycle.phase()).toBe("ended");
    expect(spies.reportFatal).toHaveBeenCalledTimes(1);
    // Unresumable now, so a trailing close cannot start another attempt.
    expect(lifecycle.sessionId()).toBeNull();
    expect(spies.resume).toHaveBeenCalledTimes(1);
  });

  test("an in-band resume rejection reports the failure exactly once", () => {
    const { spies, lifecycle } = makeLifecycle();
    lifecycle.send({ type: "READY", sessionId: "s1" });
    lifecycle.send(DROP);

    lifecycle.send({ type: "EXPIRED" });

    expect(lifecycle.phase()).toBe("ended");
    expect(spies.reportFatal).toHaveBeenCalledTimes(1);
    // The socket the rejection arrived on is still OPEN — dropping the link is
    // what stops a retired transport relaying a live provider session.
    expect(spies.dropLink).toHaveBeenCalledTimes(1);
  });

  test("a rejected resume handshake reports the failure exactly once", async () => {
    const { spies, lifecycle } = makeLifecycle({
      resume: () => Promise.reject(new Error("socket never opened")),
    });
    lifecycle.send({ type: "READY", sessionId: "s1" });

    lifecycle.send(DROP);
    await vi.waitFor(() => {
      expect(lifecycle.phase()).toBe("ended");
    });

    expect(spies.reportFatal).toHaveBeenCalledTimes(1);
    expect(spies.reportFatal.mock.calls[0]?.[0]).toContain("socket never opened");
  });

  test("a trailing close after the session ended reports nothing further", () => {
    const { spies, lifecycle } = makeLifecycle();
    lifecycle.send({ type: "READY", sessionId: "s1" });
    lifecycle.send(REJECT);
    spies.reportFatal.mockClear();

    // The close that `dropLink`'s own `handle.close()` produces.
    lifecycle.send(DROP);

    expect(lifecycle.phase()).toBe("ended");
    expect(spies.reportFatal).not.toHaveBeenCalled();
    expect(spies.resume).not.toHaveBeenCalled();
  });

  test("gives up after the resume-attempt cap on a flapping server", () => {
    const { spies, lifecycle } = makeLifecycle();
    lifecycle.send({ type: "READY", sessionId: "s1" });

    // Each round: accepted resume, then another drop.
    for (let i = 0; i < S2S_MAX_RESUME_ATTEMPTS; i++) {
      lifecycle.send(DROP);
      expect(lifecycle.phase()).toBe("resuming");
      lifecycle.send({ type: "READY", sessionId: `s${i + 2}` });
    }
    expect(spies.resume).toHaveBeenCalledTimes(S2S_MAX_RESUME_ATTEMPTS);

    lifecycle.send(DROP);

    expect(lifecycle.phase()).toBe("ended");
    expect(spies.resume).toHaveBeenCalledTimes(S2S_MAX_RESUME_ATTEMPTS);
    expect(spies.reportFatal.mock.calls[0]?.[0]).toContain(
      `abandoned after ${S2S_MAX_RESUME_ATTEMPTS} attempts`,
    );
  });

  test("a reply refills the resume budget", () => {
    const { spies, lifecycle } = makeLifecycle();
    lifecycle.send({ type: "READY", sessionId: "s1" });
    for (let i = 0; i < S2S_MAX_RESUME_ATTEMPTS; i++) {
      lifecycle.send(DROP);
      lifecycle.send({ type: "READY", sessionId: `s${i + 2}` });
    }

    // Real progress: the session is healthy, so a later drop gets a fresh
    // budget rather than the cap it was sitting on.
    lifecycle.send({ type: "PROGRESS" });
    lifecycle.send(DROP);

    expect(lifecycle.phase()).toBe("resuming");
    expect(spies.reportFatal).not.toHaveBeenCalled();
  });

  test("stop() closes the phase and reports nothing — the client asked", () => {
    const { spies, lifecycle } = makeLifecycle();
    lifecycle.send({ type: "READY", sessionId: "s1" });

    lifecycle.send({ type: "STOP" });

    expect(lifecycle.phase()).toBe("closed");
    expect(lifecycle.acceptsInbound()).toBe(false);
    expect(spies.reportFatal).not.toHaveBeenCalled();
  });

  test("stop() mid-resume closes the resume down instead of racing it", () => {
    const { spies, lifecycle } = makeLifecycle();
    lifecycle.send({ type: "READY", sessionId: "s1" });
    lifecycle.send(DROP);
    expect(lifecycle.phase()).toBe("resuming");

    lifecycle.send({ type: "STOP" });

    // `closing && reconnecting` was representable in the pair of latches this
    // replaced, and cost a half-open (billed) provider socket.
    expect(lifecycle.phase()).toBe("closed");
    expect(spies.reportFatal).not.toHaveBeenCalled();
  });

  test("a resume that settles after stop() cannot revive the session", async () => {
    let settle: (() => void) | undefined;
    const { spies, lifecycle } = makeLifecycle({
      resume: () =>
        new Promise<void>((_, reject) => {
          settle = () => reject(new Error("too late"));
        }),
    });
    lifecycle.send({ type: "READY", sessionId: "s1" });
    lifecycle.send(DROP);
    lifecycle.send({ type: "STOP" });

    settle?.();
    await Promise.resolve();

    // The invoked actor was stopped on leaving `resuming`, so its rejection has
    // nowhere to land. The three `if (closing || sessionEnded)` re-checks the
    // fire-and-forget version needed are what this replaces.
    expect(lifecycle.phase()).toBe("closed");
    expect(spies.reportFatal).not.toHaveBeenCalled();
  });

  test("the client's own close is absorbed, not reported", () => {
    const { spies, lifecycle } = makeLifecycle();
    lifecycle.send({ type: "READY", sessionId: "s1" });
    lifecycle.send({ type: "STOP" });

    lifecycle.send(DROP);

    expect(lifecycle.phase()).toBe("closed");
    expect(spies.reportFatal).not.toHaveBeenCalled();
    expect(spies.resume).not.toHaveBeenCalled();
  });

  test("inbound frames are accepted until a terminal phase, and never after", () => {
    const { lifecycle } = makeLifecycle();
    expect(lifecycle.acceptsInbound()).toBe(true);
    lifecycle.send({ type: "READY", sessionId: "s1" });
    expect(lifecycle.acceptsInbound()).toBe(true);
    lifecycle.send(DROP);
    // Still live enough to relay: the session exists, its socket is being
    // replaced.
    expect(lifecycle.acceptsInbound()).toBe(true);

    lifecycle.send(REJECT);

    expect(lifecycle.phase()).toBe("ended");
    expect(lifecycle.acceptsInbound()).toBe(false);
  });

  test("session.expired outside a resume hangs up and lets the close decide", () => {
    const { spies, lifecycle } = makeLifecycle();
    lifecycle.send({ type: "READY", sessionId: "s1" });

    lifecycle.send({ type: "EXPIRED" });

    // Not fatal by itself: closing the handle produces the close event that is.
    expect(lifecycle.phase()).toBe("live");
    expect(spies.closeHandle).toHaveBeenCalledTimes(1);
    expect(spies.reportFatal).not.toHaveBeenCalled();
  });

  test("a mid-reply close names the reply it lost", () => {
    const { spies, lifecycle } = makeLifecycle({ currentReplyId: () => "r7" });
    lifecycle.send({ type: "READY", sessionId: "s1" });

    lifecycle.send(REJECT);

    expect(spies.reportFatal.mock.calls[0]?.[0]).toContain("mid-reply");
    expect(spies.log).toHaveBeenCalledWith(
      "warn",
      "S2S closed with active reply",
      expect.objectContaining({ activeReplyId: "r7" }),
    );
  });
});
