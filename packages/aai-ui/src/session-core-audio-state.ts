// Copyright 2026 the AAI authors. MIT license.
/**
 * The browser session's AUDIO PATH — the mic grant, the worklets, and the
 * {@link VoiceIO} they produce — as a statechart.
 *
 * It was a latch, an epoch counter and three buffers spread across
 * `ConnState`, and every one of them was a question the position already
 * answers:
 *
 * - **`audioSetupInFlight` was a dedup, and dedup is a state.**
 *   `initAudioCapture` opened with `if (conn.audioSetupInFlight) return` and
 *   closed with "only the init that still owns the flag may clear it", which is
 *   an ownership problem a boolean cannot express and a position does not have.
 *   Here `starting` simply does not handle `START`, and there is no flag to
 *   hand back.
 * - **`conn.generation` existed for this module and nothing else.** Four
 *   `bump()` sites, four `isCurrent(gen)` reads, and its own field on
 *   `ConnState`. All four bumps sat immediately after a `cleanupAudio()` that
 *   had *just* cleared the in-flight flag — the reconnect close handler said so
 *   outright ("cleanupAudio just cleared the in-flight flag, so a survivor
 *   would otherwise pass the same-generation guard and double-run"). Two
 *   mechanisms for one question, the second one layered on because the first
 *   could not stop the work already running. A stopped `invoke` can, so the
 *   counter is gone.
 * - **A counter cannot tell two bring-ups in ONE generation apart, and they
 *   happen.** A repeated `config` frame on a live connection re-opened the path
 *   without bumping anything, so the outgoing `VoiceIO`'s `onError` still
 *   passed `isCurrent(gen)` and could tear down the replacement that had just
 *   taken its slot. `PROGRESS` and `IO_FAILED` carry the instance that fired
 *   them now, and identity is exact where a counter was approximate.
 * - **`preInitAudio` / `preInitDone` are only meaningful while the path is
 *   down.** As connection fields they were readable — and writable — from
 *   anywhere; as context of `down`/`starting` they are cleared by entering
 *   `down` rather than by three call sites remembering to.
 *
 * ## What cancellation does NOT do, and the one guard that had to survive
 *
 * Stopping the `bringUp` actor hides its resolution; it does not close a
 * microphone the browser has already granted. So `bringUp` checks its own
 * `signal` after `openAudioPath` settles and releases what it built. That is
 * the single remaining "is this still wanted?" test, and it lives in the
 * producer — which owns the value nobody adopted — rather than at the four
 * consumer sites that used to re-ask.
 *
 * ## Effects stay in the session core
 *
 * The machine owns WHEN. Every HOW — the socket frame, the snapshot write, the
 * turn-boundary drain — arrives as an injected {@link AudioPathEffects} call,
 * the same shape `s2s-lifecycle.ts` uses. So this module touches no socket and
 * no snapshot.
 */

import { errorMessage } from "@alexkroman1/aai";
import { assign, createActor, fromPromise, setup } from "xstate";
import type { VoiceIO } from "./audio.ts";
import type { AudioPathCallbacks, AudioPathConfig } from "./session-core-audio-setup.ts";

/**
 * Cap on audio chunks buffered while the path is coming up. ~100 chunks at
 * typical S2S chunk sizes is well over a second of audio — far longer than a
 * bring-up takes in practice, but bounded against pathological cases
 * (mic-permission stalls).
 */
const MAX_BUFFERED_CHUNKS = 100;

/**
 * The rejection a bring-up abandons itself with.
 *
 * Never observed: the actor is already stopped when it is thrown, and XState
 * drops a settlement from a stopped actor. It exists so the `async` function
 * has a way to end that is not "resolve with a VoiceIO I have just closed".
 */
const ABANDONED = new Error("audio path abandoned");

/** Where the audio path is. */
export type AudioPathPhase = "down" | "starting" | "up";

/**
 * The session core's side of the machine: everything the audio path decides to
 * do but does not know how to.
 */
export type AudioPathEffects = {
  /**
   * Open one audio path — `openAudioPath` in `session-core-audio-setup.ts`.
   * Injected rather than imported so this module needs no browser: the specs
   * hand it a promise they resolve by hand, which is the only way to hold a
   * bring-up open across the events that abandon it.
   */
  open(config: AudioPathConfig, callbacks: AudioPathCallbacks): Promise<VoiceIO>;
  /** Relay captured microphone audio to the server. */
  sendMicAudio(pcm16: ArrayBuffer): void;
  /** Tell the server how much agent audio is still unplayed. */
  reportProgress(bufferedMs: number): void;
  /** Tell the server the microphone is live. */
  announceReady(): void;
  /** The microphone is live: the snapshot's `recording`. */
  micLive(): void;
  /** Back to the mic, with no audio left to wait for. */
  listen(): void;
  /**
   * Wait for `io` to drain, then listen — guarded by the turn boundary, so a
   * completion landing after a barge-in or a teardown is discarded.
   */
  settleWhenDrained(io: VoiceIO): void;
  /**
   * Report a non-fatal audio failure and stop the mic. Non-fatal because the
   * socket may well still be fine, so a later server frame is allowed to
   * recover the banner — see `session-core-state.ts`.
   */
  reportFailure(message: string): void;
  /**
   * The audio path is gone: end whatever turn it was playing.
   *
   * Paired with the release below rather than folded into it, because the
   * bump has to happen on every path into `down` — including a bring-up that
   * failed before there was anything to close.
   */
  endTurn(): void;
  /** Close `io` and let go of the microphone. Best-effort. */
  release(io: VoiceIO): void;
};

/** Everything that happens to the audio path. */
export type AudioPathEvent =
  /** The server's `config` frame: bring the path up for these rates. */
  | { type: "START"; config: AudioPathConfig }
  /** A PCM16 chunk arrived for playback. */
  | { type: "CHUNK"; chunk: ArrayBuffer }
  /** The server finished sending this turn's audio. */
  | { type: "DONE" }
  /** A live path reported its unplayed depth. */
  | { type: "PROGRESS"; io: VoiceIO; bufferedMs: number }
  /** A live path's worklet died. */
  | { type: "IO_FAILED"; io: VoiceIO; message: string }
  /** Release the audio path: hang-up, reconnect, fatal frame, session end. */
  | { type: "TEARDOWN" };

type Context = {
  effects: AudioPathEffects;
  /** The live path, or null while there is none. */
  io: VoiceIO | null;
  /**
   * Audio that arrived before the path was up — drained into the worklet on
   * adoption. Closes the race between the server starting greeting audio
   * (immediately on S2S connect) and the client awaiting mic permission plus
   * worklet registration.
   */
  pending: ArrayBuffer[];
  /**
   * An `audio.completed` arrived before the path was up. The done has to be
   * replayed after the buffer drains, or a greeting shorter than the worklet's
   * jitter buffer never finishes playing.
   */
  pendingDone: boolean;
  /** The rates the next bring-up runs with. */
  config: AudioPathConfig | null;
};

/** What one bring-up needs: the effects, the rates, and a way back in. */
type BringUpInput = {
  effects: AudioPathEffects;
  config: AudioPathConfig;
  send: (event: AudioPathEvent) => void;
};

const audioPathMachine = setup({
  types: {} as { context: Context; input: AudioPathEffects; events: AudioPathEvent },
  actors: {
    /**
     * One bring-up. An actor rather than a fire-and-forget `void init(...)`
     * precisely so that leaving `starting` — a hang-up, a reconnect, a fatal
     * frame — stops it, instead of letting it settle into a connection that is
     * already over.
     */
    bringUp: fromPromise(
      async ({ input, signal }: { input: BringUpInput; signal: AbortSignal }) => {
        // The callbacks exist before the VoiceIO they belong to, so they reach
        // it through this. Silent until adoption: a path the machine has
        // already abandoned reports nothing, and one that has not been adopted
        // yet has no position to report from.
        let mine: VoiceIO | null = null;
        const callbacks: AudioPathCallbacks = {
          onMicData: (pcm16) => input.effects.sendMicAudio(pcm16),
          onProgress: (bufferedMs) => {
            if (mine) input.send({ type: "PROGRESS", io: mine, bufferedMs });
          },
          onFailure: (message) => {
            if (mine) input.send({ type: "IO_FAILED", io: mine, message });
          },
        };
        const io = await input.effects.open(input.config, callbacks);
        // Stopped while the browser was deciding. XState will drop this
        // resolution, which is exactly the problem: nothing else knows a
        // microphone was opened, so the release has to happen here.
        if (signal.aborted) {
          input.effects.release(io);
          throw ABANDONED;
        }
        mine = io;
        return io;
      },
    ),
  },
  guards: {
    /**
     * Did the live path report this, or one it replaced?
     *
     * Identity rather than `generation.isCurrent(gen)`: two bring-ups inside a
     * single connection share a generation, and the counter passed for the
     * instance that had just been closed.
     */
    fromLiveIo: ({ context, event }) =>
      (event.type === "PROGRESS" || event.type === "IO_FAILED") && context.io === event.io,
  },
  actions: {
    rememberConfig: assign({
      config: ({ context, event }) => (event.type === "START" ? event.config : context.config),
    }),
    /** Hold a chunk that arrived too early, up to the cap. */
    buffer: assign({
      pending: ({ context, event }) =>
        event.type === "CHUNK" && context.pending.length < MAX_BUFFERED_CHUNKS
          ? [...context.pending, event.chunk]
          : context.pending,
    }),
    /** Record a done that arrived too early. */
    rememberDone: assign({ pendingDone: true }),
    /** Answer it optimistically: with no audio pipeline there is nothing to wait for. */
    listenNow: ({ context }) => context.effects.listen(),
    /** Nothing buffered belongs to the next path. */
    forgetBuffered: assign({ io: null, pending: [], pendingDone: false }),
    /** Releasing the path ends the turn it was playing — see `endTurn`. */
    endTurn: ({ context }) => context.effects.endTurn(),
    releaseIo: ({ context }) => {
      if (context.io) context.effects.release(context.io);
    },
  },
}).createMachine({
  id: "audioPath",
  context: ({ input }) => ({
    effects: input,
    io: null,
    pending: [],
    pendingDone: false,
    config: null,
  }),
  initial: "down",
  on: {
    // Root-level, because all three are facts about the session rather than
    // about any one position in the audio path's life. `up` overrides the
    // first two; XState runs the child's handler alone when it matches, so
    // these are the not-yet-playing arms.
    CHUNK: { actions: "buffer" },
    DONE: { actions: ["rememberDone", "listenNow"] },
    TEARDOWN: ".down",
  },
  states: {
    /**
     * No audio path. Entered on every release, so its entry is the one place
     * that ends the turn and drops what was buffered for a path that is gone.
     */
    down: {
      entry: ["endTurn", "forgetBuffered"],
      on: { START: { target: "starting", actions: "rememberConfig" } },
    },
    /**
     * A bring-up is in flight.
     *
     * `START` is absent deliberately: that is the whole of what
     * `audioSetupInFlight` said, and a second `config` frame arriving mid-grant
     * is now declined by the position rather than by a flag whose owner had to
     * be tracked.
     */
    starting: {
      invoke: {
        src: "bringUp",
        input: ({ context, self }) => ({
          effects: context.effects,
          // Non-null on the one edge into this state, which carries a `START`.
          config: context.config ?? { sampleRate: 0, ttsSampleRate: 0 },
          send: (event: AudioPathEvent) => {
            self.send(event);
          },
        }),
        onDone: {
          target: "up",
          actions: [
            // Before the adoption below, which clears the buffer: the greeting
            // that arrived during the grant is this path's first audio.
            ({ context, event }) => {
              for (const chunk of context.pending) event.output.enqueue(chunk);
            },
            assign({ io: ({ event }) => event.output, pending: [] }),
            // After it, because announcing publishes a snapshot: a subscriber
            // that barges in on the news has to find the live path, not the
            // null it was a line ago.
            ({ context, event }) => {
              context.effects.announceReady();
              context.effects.micLive();
              if (context.pendingDone) context.effects.settleWhenDrained(event.output);
              else context.effects.listen();
            },
            assign({ pendingDone: false }),
          ],
        },
        // Inline rather than a named action: only here is `event` the error
        // event, and only here does its `error` narrow.
        onError: {
          target: "down",
          actions: ({ context, event }) => {
            context.effects.reportFailure(`Microphone access failed: ${errorMessage(event.error)}`);
          },
        },
      },
    },
    /**
     * A live path. Its exit releases it, which covers all three ways out —
     * teardown, a worklet death, and the repeated `config` frame that opens a
     * replacement (the "defensive" close that used to sit inside the bring-up,
     * where it could only run if the bring-up got that far).
     */
    up: {
      exit: "releaseIo",
      on: {
        START: { target: "starting", actions: "rememberConfig" },
        CHUNK: { actions: ({ context, event }) => context.io?.enqueue(event.chunk) },
        DONE: {
          actions: ({ context }) => {
            if (context.io) context.effects.settleWhenDrained(context.io);
          },
        },
        PROGRESS: {
          guard: "fromLiveIo",
          actions: ({ context, event }) => context.effects.reportProgress(event.bufferedMs),
        },
        IO_FAILED: {
          guard: "fromLiveIo",
          target: "down",
          actions: ({ context, event }) => context.effects.reportFailure(event.message),
        },
      },
    },
  },
});

/** The session core's handle on its audio path. */
export type AudioPath = {
  /** Where the path is. */
  phase(): AudioPathPhase;
  /** The server named the audio rates: bring the path up. */
  start(config: AudioPathConfig): void;
  /** Play a chunk, or hold it until there is somewhere to play it. */
  enqueue(chunk: ArrayBuffer): void;
  /** The server finished this turn's audio. */
  done(): void;
  /**
   * Barge-in: discard what is queued for playback.
   *
   * A read rather than an event — it moves the path nowhere, and a turn
   * boundary is the caller's to declare (see `bargeIn`).
   */
  flush(): void;
  /** Release the microphone and forget anything buffered. */
  teardown(): void;
};

/** Create the audio path for one browser session. */
export function createAudioPath(effects: AudioPathEffects): AudioPath {
  const actor = createActor(audioPathMachine, { input: effects }).start();
  return {
    phase: () => actor.getSnapshot().value,
    start: (config) => {
      actor.send({ type: "START", config });
    },
    enqueue: (chunk) => {
      actor.send({ type: "CHUNK", chunk });
    },
    done: () => {
      actor.send({ type: "DONE" });
    },
    flush: () => actor.getSnapshot().context.io?.flush(),
    teardown: () => {
      actor.send({ type: "TEARDOWN" });
    },
  };
}
