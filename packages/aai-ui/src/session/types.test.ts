// Copyright 2026 the AAI authors. MIT license.
/**
 * The two runtime helpers in session/types.ts.
 *
 * `bargeIn` is one fact written as two calls — end the turn AND settle what it
 * was playing — and both halves are load-bearing, so the spec asserts both
 * happen and in which order. `STOPPED` is the liveness pair every transition
 * that ends a call spreads.
 */

import { createEpoch } from "@alexkroman1/aai/internal";
import { describe, expect, it, vi } from "vitest";
import type { AudioPath } from "./audio-state.ts";
import { bargeIn, type ConnState, STOPPED } from "./types.ts";

/** An audio path that records what was asked of it. */
function recordingPath(): AudioPath & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    phase: () => "up",
    start: vi.fn(),
    enqueue: vi.fn(),
    done: vi.fn(),
    flush: () => calls.push("flush"),
    teardown: vi.fn(),
  };
}

describe("bargeIn", () => {
  it("ends the turn, then settles its playback", () => {
    const epoch = createEpoch();
    const before = epoch.current();
    const audio = recordingPath();
    // The real epoch, with the bump's position recorded beside the flush.
    const turn = {
      ...epoch,
      bump: () => {
        audio.calls.push("bump");
        epoch.bump();
      },
    };
    const conn: ConnState = { ws: null, turn };

    bargeIn(conn, audio);

    expect(audio.calls).toEqual(["bump", "flush"]);
    // A drain continuation from the interrupted turn is now stale.
    expect(epoch.isCurrent(before)).toBe(false);
  });

  it("touches nothing else on the path", () => {
    const audio = recordingPath();
    bargeIn({ ws: null, turn: createEpoch() }, audio);
    expect(audio.teardown).not.toHaveBeenCalled();
    expect(audio.done).not.toHaveBeenCalled();
  });
});

describe("STOPPED", () => {
  it("is both liveness fields at rest, and nothing more", () => {
    expect(STOPPED).toEqual({ running: false, recording: false });
  });
});
