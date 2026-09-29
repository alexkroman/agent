// Copyright 2026 the AAI authors. MIT license.
/**
 * `useInbox()`'s built-in playback: a notice's PCM through an `AudioContext` of
 * its own.
 *
 * **Its own context, not the session's.** The session's playback context exists
 * only while a session is up (it is built on the `config` frame and closed on
 * hang-up), and a notice arrives exactly when no session is — that is the
 * inbox's whole reason to exist. It also runs through a jitter-buffer worklet
 * tuned for a streamed reply, and a notice is one finished buffer.
 *
 * **Unlocked by the first user gesture, because of the autoplay policy.** A
 * context created outside a gesture starts `suspended` and stays silent until
 * `resume()` is called INSIDE one — and a reminder arrives hours after the last
 * click. So the player is unlocked from a capture-phase `pointerdown` /
 * `keydown` listener (`useInbox` installs it), which creates and resumes the
 * context while the browser still counts the page as activated; afterwards a
 * notice plays whenever it lands. A page that has had no gesture at all plays
 * nothing, which is the browser's rule and not one this can route around.
 *
 * **16 kHz** because that is what an inbox notice carries: the rate the device
 * protocol fixed (`inbox.c` plays at `BOARD_SAMPLE_RATE`), so a step building a
 * notice asks `stepSpeak` for it (`stepSpeak`'s own default is 24 kHz — a notice
 * at that rate plays slow and low here; pass `play: false` and play it
 * yourself). The buffer is created at 16 kHz and the context resamples it — no
 * worklet, no resampler of ours.
 */

/** The rate a notice's PCM16LE mono is played at. */
export const NOTICE_SAMPLE_RATE = 16_000;

/** The slice of `AudioBuffer` the player writes. */
export type NoticeBuffer = { getChannelData(channel: number): Float32Array };

/** The slice of `AudioBufferSourceNode` the player drives. */
export type NoticeSource = {
  buffer: NoticeBuffer | null;
  onended: ((ev: never) => unknown) | null;
  connect(destination: unknown): unknown;
  start(): void;
  stop(): void;
};

/**
 * The slice of `AudioContext` the player uses — declared rather than `Pick`ed
 * so a test's fake satisfies it without a cast, and injectable because jsdom
 * has no `AudioContext`. `defaultContext()` below is what proves the real one
 * still fits.
 */
export type NoticeAudioContext = {
  readonly state: AudioContextState;
  readonly destination: unknown;
  resume(): Promise<void>;
  close(): Promise<void>;
  createBuffer(channels: number, length: number, sampleRate: number): NoticeBuffer;
  createBufferSource(): NoticeSource;
};

/** A notice player — see the module doc. */
export type NoticePlayer = {
  /** Create and resume the context — call from inside a user gesture. */
  unlock(): void;
  /** Play `pcm` (PCM16LE mono at {@link NOTICE_SAMPLE_RATE}); empty audio plays nothing. */
  play(pcm: Uint8Array): void;
  /** Stop every notice still playing. */
  stop(): void;
  /** Stop, and release the context. A later `unlock()`/`play()` makes a new one. */
  close(): void;
};

/**
 * @param makeContext - How a context is made; the page's `AudioContext` by
 *   default. Where there is none (a server render, jsdom) the player is silent.
 */
export function createNoticePlayer(
  makeContext: (() => NoticeAudioContext) | undefined = defaultContext(),
): NoticePlayer {
  let ctx: NoticeAudioContext | undefined;
  const playing = new Set<NoticeSource>();

  function context(): NoticeAudioContext | undefined {
    if (!makeContext) return undefined;
    ctx ??= makeContext();
    // A failed resume leaves the context suspended; the next gesture retries.
    if (ctx.state === "suspended") ctx.resume().catch(() => undefined);
    return ctx;
  }

  function stop(): void {
    for (const src of playing) src.stop();
    playing.clear();
  }

  return {
    unlock: () => {
      context();
    },
    play(bytes) {
      const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
      if (pcm.length === 0) return;
      const ac = context();
      if (!ac) return;
      const buffer = ac.createBuffer(1, pcm.length, NOTICE_SAMPLE_RATE);
      const samples = buffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) samples[i] = (pcm[i] ?? 0) / 32_768;
      const src = ac.createBufferSource();
      src.buffer = buffer;
      src.connect(ac.destination);
      src.onended = () => playing.delete(src);
      playing.add(src);
      src.start();
    },
    stop,
    close() {
      stop();
      ctx?.close().catch(() => undefined);
      ctx = undefined;
    },
  };
}

function defaultContext(): (() => NoticeAudioContext) | undefined {
  const Ctor = globalThis.AudioContext;
  if (typeof Ctor !== "function") return undefined;
  return (): NoticeAudioContext => new Ctor();
}
