// Copyright 2026 the AAI authors. MIT license.
/**
 * Unit specs for the audio path's statechart.
 *
 * `session-core-audio-init.test.ts` drives the same rules through a socket,
 * which is what proves the wiring. These state the INVARIANTS directly — the
 * ones that used to be a latch nobody owned and an epoch counter bumped from
 * four other modules: what a bring-up in flight refuses, what happens to a
 * microphone granted for a connection that is already gone, and which reports
 * a replaced path is allowed to make.
 */

import { describe, expect, it, vi } from "vitest";
import { tick } from "./_react-test-utils.ts";
import type { VoiceIO } from "./audio.ts";
import type { AudioPathCallbacks, AudioPathConfig } from "./session-core-audio-setup.ts";
import { type AudioPathEffects, createAudioPath } from "./session-core-audio-state.ts";

const CONFIG: AudioPathConfig = { sampleRate: 16_000, ttsSampleRate: 24_000 };

function makeIO(done: () => Promise<void> = () => Promise.resolve()): VoiceIO {
  const io: VoiceIO = {
    enqueue: vi.fn<(buf: ArrayBuffer) => void>(),
    done,
    flush: vi.fn<() => void>(),
    close: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    async [Symbol.asyncDispose]() {
      await io.close();
    },
  };
  return io;
}

/**
 * A path whose `open` never settles on its own: the test holds each bring-up
 * open and releases it, which is the only way to be inside `starting` when the
 * events that abandon one arrive.
 */
function harness() {
  const opens: { resolve(io: VoiceIO): void; reject(err: unknown): void }[] = [];
  /** The callbacks each bring-up handed to `open`, so a spec can fire one. */
  const callbacks: AudioPathCallbacks[] = [];
  const effects = {
    open: vi.fn((_config: AudioPathConfig, cbs: AudioPathCallbacks) => {
      callbacks.push(cbs);
      return new Promise<VoiceIO>((resolve, reject) => {
        opens.push({ resolve, reject });
      });
    }),
    sendMicAudio: vi.fn(),
    reportProgress: vi.fn(),
    announceReady: vi.fn(),
    micLive: vi.fn(),
    listen: vi.fn(),
    settleWhenDrained: vi.fn(),
    reportFailure: vi.fn(),
    endTurn: vi.fn(),
    release: vi.fn(),
  } satisfies AudioPathEffects;
  return { audio: createAudioPath(effects), effects, opens, callbacks };
}

describe("createAudioPath", () => {
  it("starts down and comes up on the config frame", async () => {
    const { audio, effects, opens } = harness();
    expect(audio.phase()).toBe("down");

    audio.start(CONFIG);
    expect(audio.phase()).toBe("starting");
    expect(effects.open).toHaveBeenCalledWith(CONFIG, expect.anything());

    opens[0]?.resolve(makeIO());
    await tick();

    expect(audio.phase()).toBe("up");
    expect(effects.announceReady).toHaveBeenCalledOnce();
    expect(effects.micLive).toHaveBeenCalledOnce();
    expect(effects.listen).toHaveBeenCalledOnce();
  });

  it("a bring-up in flight refuses a second one", async () => {
    const { audio, effects, opens } = harness();
    audio.start(CONFIG);

    // What `audioSetupInFlight` used to say. A repeated `config` frame mid-grant
    // is declined by the position, so there is no second mic to orphan.
    audio.start(CONFIG);
    audio.start(CONFIG);
    expect(effects.open).toHaveBeenCalledOnce();

    opens[0]?.resolve(makeIO());
    await tick();
    expect(effects.announceReady).toHaveBeenCalledOnce();
  });

  it("releases a microphone granted after the bring-up was abandoned", async () => {
    const { audio, effects, opens } = harness();
    audio.start(CONFIG);

    // The hang-up/reconnect/fatal-frame case. Stopping the actor hides the
    // resolution; it does not close the device, so the bring-up has to.
    audio.teardown();
    expect(audio.phase()).toBe("down");

    const io = makeIO();
    opens[0]?.resolve(io);
    await tick();

    expect(effects.release).toHaveBeenCalledWith(io);
    expect(audio.phase()).toBe("down");
    // Nothing was adopted, so nothing was announced to the server.
    expect(effects.announceReady).not.toHaveBeenCalled();
    expect(effects.micLive).not.toHaveBeenCalled();
  });

  it("a failed bring-up reports and stays down", async () => {
    const { audio, effects, opens } = harness();
    audio.start(CONFIG);

    opens[0]?.reject(new Error("Permission denied"));
    await tick();

    expect(audio.phase()).toBe("down");
    expect(effects.reportFailure).toHaveBeenCalledWith(
      "Microphone access failed: Permission denied",
    );
    // The turn the dead path was serving ends, or a drain resolving behind it
    // stamps "listening" over the banner just reported.
    expect(effects.endTurn).toHaveBeenCalled();
  });

  it("audio that arrives before the path is up is drained into it, in order", async () => {
    const { audio, opens } = harness();
    const early = new ArrayBuffer(4);
    const duringGrant = new ArrayBuffer(8);

    audio.enqueue(early);
    audio.start(CONFIG);
    audio.enqueue(duringGrant);

    const io = makeIO();
    opens[0]?.resolve(io);
    await tick();

    expect(io.enqueue).toHaveBeenNthCalledWith(1, early);
    expect(io.enqueue).toHaveBeenNthCalledWith(2, duringGrant);

    // Once up, a chunk goes straight through.
    const live = new ArrayBuffer(2);
    audio.enqueue(live);
    expect(io.enqueue).toHaveBeenNthCalledWith(3, live);
  });

  it("a done that arrives during the grant is replayed as a drain, not a bare listen", async () => {
    const { audio, effects, opens } = harness();
    audio.start(CONFIG);
    audio.enqueue(new ArrayBuffer(4));

    // Answered optimistically: there is no audio pipeline to wait for yet.
    audio.done();
    expect(effects.listen).toHaveBeenCalledOnce();
    expect(effects.settleWhenDrained).not.toHaveBeenCalled();

    const io = makeIO();
    opens[0]?.resolve(io);
    await tick();

    // And replayed, so a greeting shorter than the jitter buffer still plays out.
    expect(effects.settleWhenDrained).toHaveBeenCalledWith(io);
    expect(effects.listen).toHaveBeenCalledOnce();
  });

  it("a done on a live path waits for the drain", async () => {
    const { audio, effects, opens } = harness();
    audio.start(CONFIG);
    const io = makeIO();
    opens[0]?.resolve(io);
    await tick();

    audio.done();
    expect(effects.settleWhenDrained).toHaveBeenCalledWith(io);
  });

  it("a replaced path may not report progress or failure", async () => {
    const { audio, effects, opens, callbacks } = harness();
    audio.start(CONFIG);
    const first = makeIO();
    opens[0]?.resolve(first);
    await tick();

    // A repeated `config` on a live connection: the outgoing path is released
    // and a replacement opens. Both share what used to be one generation, so
    // the counter could not tell them apart — identity can.
    audio.start(CONFIG);
    expect(effects.release).toHaveBeenCalledWith(first);
    const second = makeIO();
    opens[1]?.resolve(second);
    await tick();

    callbacks[0]?.onProgress(120);
    callbacks[0]?.onFailure("playback worklet died");
    expect(effects.reportProgress).not.toHaveBeenCalled();
    expect(effects.reportFailure).not.toHaveBeenCalled();
    expect(audio.phase()).toBe("up");

    // The live one still speaks for itself.
    callbacks[1]?.onProgress(80);
    expect(effects.reportProgress).toHaveBeenCalledWith(80);
  });

  it("a live path's worklet death releases it and reports", async () => {
    const { audio, effects, opens, callbacks } = harness();
    audio.start(CONFIG);
    const io = makeIO();
    opens[0]?.resolve(io);
    await tick();

    callbacks[0]?.onFailure("playback worklet died");

    expect(audio.phase()).toBe("down");
    expect(effects.release).toHaveBeenCalledWith(io);
    expect(effects.reportFailure).toHaveBeenCalledWith("playback worklet died");
    expect(effects.endTurn).toHaveBeenCalled();
  });

  it("teardown releases the path and forgets what was buffered for it", async () => {
    const { audio, effects, opens } = harness();
    audio.start(CONFIG);
    const first = makeIO();
    opens[0]?.resolve(first);
    await tick();

    audio.enqueue(new ArrayBuffer(4));
    audio.teardown();
    expect(effects.release).toHaveBeenCalledWith(first);
    expect(audio.phase()).toBe("down");

    // A chunk held for the path that just died must not be replayed into its
    // successor — it belongs to a conversation that is over.
    audio.start(CONFIG);
    const second = makeIO();
    opens[1]?.resolve(second);
    await tick();
    expect(second.enqueue).not.toHaveBeenCalled();
  });

  it("flush reaches the live path only", async () => {
    const { audio, opens } = harness();
    // Nothing to flush while down — a barge-in before the mic is up is a no-op.
    expect(() => audio.flush()).not.toThrow();

    audio.start(CONFIG);
    const io = makeIO();
    opens[0]?.resolve(io);
    await tick();

    audio.flush();
    expect(io.flush).toHaveBeenCalledOnce();
  });
});
