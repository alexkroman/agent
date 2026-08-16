// Copyright 2025 the AAI authors. MIT license.

/**
 * Test utilities for React-based component tests.
 * No dependency on @preact/signals.
 */

import { act } from "react";
import type { SessionCore, SessionSnapshot } from "./session-core-types.ts";

/**
 * Create a mock SessionCore for React component tests.
 *
 * Returns a `SessionCore`-compatible object with mutable snapshot. Call
 * `core.update(partial)` to mutate the snapshot and notify subscribers,
 * triggering React re-renders.
 */
export function createMockSessionCore(
  overrides?: Partial<SessionSnapshot>,
): SessionCore & { update(partial: Partial<SessionSnapshot>): void } {
  let snapshot: SessionSnapshot = {
    state: "disconnected",
    contentVersion: 0,
    messages: [],
    toolCalls: [],
    customEvents: [],
    agentState: null,
    userTranscript: null,
    agentTranscript: null,
    error: null,
    started: false,
    running: true,
    recording: false,
    apiUrl: "ws://test.local/websocket",
    ...overrides,
  };

  const subscribers = new Set<() => void>();

  function notify() {
    for (const sub of subscribers) sub();
  }

  const core: SessionCore & { update(partial: Partial<SessionSnapshot>): void } = {
    getSnapshot() {
      return snapshot;
    },
    subscribe(cb: () => void) {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
    connect() {
      /* noop */
    },
    cancel() {
      /* noop */
    },
    resetState() {
      /* noop */
    },
    reset() {
      /* noop */
    },
    disconnect() {
      /* noop */
    },
    start() {
      snapshot = { ...snapshot, started: true, running: true };
      notify();
    },
    toggle() {
      snapshot = { ...snapshot, running: !snapshot.running };
      notify();
    },
    end() {
      snapshot = { ...snapshot, started: false, running: false, recording: false };
      notify();
    },
    update(partial: Partial<SessionSnapshot>) {
      // Mirror the real core: content changes bump contentVersion. An explicit
      // contentVersion in `partial` wins, so tests can pin it for updates the
      // real core would not treat as content (e.g. `recording`).
      snapshot = { ...snapshot, contentVersion: snapshot.contentVersion + 1, ...partial };
      notify();
    },
    [Symbol.dispose]() {
      /* noop */
    },
  };

  return core;
}

/**
 * Flush pending effects and microtasks inside React's `act()` window.
 *
 * The idiom is `await act(async () => {})`, and a bare empty block is
 * indistinguishable from an unfinished refactor — Biome's
 * `noEmptyBlockStatements` is right to reject it, and a Biome suppression
 * comment would be a counted escape hatch. Naming it once says the intent
 * instead, and de-duplicates the three specs that were reaching for it.
 *
 * (The wording matters: `check:hatches` matches plain substrings with no notion
 * of code versus prose, and unlike the cast patterns it cannot skip
 * comment-only lines — a suppression directive genuinely IS a comment. So a
 * doc comment naming the directive literally scores as one, and this file's
 * budget is zero.)
 *
 * `act` comes from `react`, not `@testing-library/react`: this module is
 * imported by the node-environment session specs too, and only the DOM
 * renderer's entry point belongs behind jsdom.
 *
 * Use it where an assertion must land on the SETTLED frame rather than the one
 * an effect renders optimistically before its first `await` resolves.
 */
export function flushEffects(): Promise<void> {
  return act(async () => {
    await Promise.resolve();
  });
}

/**
 * Yield a full MACROTASK — drains microtasks and lets already-scheduled
 * zero-delay timers run.
 *
 * The sibling of `tick()` in `aai/host/_test-utils.ts`, spelled again here
 * because that module is `_`-internal and may not be imported across packages.
 * Named `tick`, not `flush`, for the reason its doc gives: `flush()` means a
 * MICROTASK yield repo-wide, and one identifier meaning two different waits is
 * what that split exists to prevent.
 *
 * Reach for this rather than writing the promise out: an inline
 * `new Promise<void>((r) => setTimeout(r, 0))` is invisible to
 * `guard-invariants` rules 4 and 19 — the `<void>` type argument breaks the
 * literal `new Promise(` both patterns require — so the one occurrence in this
 * package was in no baseline and reported by nothing.
 */
export function tick(): Promise<void> {
  return new Promise<void>((r) => {
    setTimeout(r, 0);
  });
}

// ─── Audio mock utilities ────────────────────────────────────────────────────

function noop() {
  /* intentional no-op */
}

/** Default voice options for tests. */
export function voiceOpts(overrides?: Partial<import("./audio.ts").VoiceIOOptions>) {
  return {
    sttSampleRate: 16_000,
    ttsSampleRate: 24_000,
    captureWorkletSrc: "cap",
    playbackWorkletSrc: "play",
    onMicData: noop,
    ...overrides,
  };
}

export class MockMessagePort {
  onmessage: ((e: MessageEvent) => void) | null = null;
  posted: unknown[] = [];
  postMessage(data: unknown, _transfer?: Transferable[]) {
    this.posted.push(data);
    // Mirror the capture worklet's stop→stopped ack so VoiceIO.close()
    // resolves on the ack instead of waiting out its fallback timeout.
    if ((data as { event?: string }).event === "stop") {
      queueMicrotask(() => this.simulateMessage({ event: "stopped" }));
    }
  }
  simulateMessage(data: unknown) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
}

export class MockAudioNode {
  connected: (MockAudioNode | MockAudioWorkletNode)[] = [];
  connect(dest: MockAudioNode | MockAudioWorkletNode) {
    this.connected.push(dest);
  }
  disconnect() {
    /* noop */
  }
}

export class MockAudioWorkletNode {
  port = new MockMessagePort();
  connected: MockAudioNode[] = [];
  name: string;
  options: unknown;
  /** The context this node was constructed on — capture and playback use
   *  separate contexts, so tests need to tell them apart. */
  ctx: MockAudioContext;
  constructor(ctx: MockAudioContext, name: string, options?: unknown) {
    this.ctx = ctx;
    this.name = name;
    this.options = options;
  }
  connect(dest: MockAudioNode) {
    this.connected.push(dest);
  }
  disconnect() {
    /* noop */
  }
}

export class MockAudioContext {
  sampleRate: number;
  state: AudioContextState = "running";
  currentTime = 0;
  destination = new MockAudioNode();
  audioWorklet = {
    modules: [] as string[],
    addModule(url: string) {
      this.modules.push(url);
      return Promise.resolve();
    },
  };
  closed = false;

  constructor(opts?: { sampleRate?: number }) {
    this.sampleRate = opts?.sampleRate ?? 44_100;
  }
  resume() {
    return Promise.resolve();
  }
  createMediaStreamSource(_stream: unknown) {
    return new MockAudioNode();
  }
  close() {
    this.closed = true;
    this.state = "closed";
    return Promise.resolve();
  }
}

export type AudioMockContext = {
  lastContext: () => MockAudioContext;
  /** Every context constructed, in order. */
  contexts: () => MockAudioContext[];
  workletNodes: () => MockAudioWorkletNode[];
  /** Constraints passed to the last getUserMedia call. */
  lastAudioConstraints: () => MediaTrackConstraints | undefined;
};

/** Options for {@link installAudioMocks}. */
export type AudioMockOptions = {
  /**
   * Report this rate from every context regardless of what was requested,
   * standing in for a browser that ignores the `sampleRate` hint.
   */
  forceSampleRate?: number;
};

/**
 * `globalThis` as a mutable bag, for installing incomplete DOM mocks
 * (`AudioContext`, `navigator`) that do not satisfy the real interfaces.
 * Exported so tests share this one widening; the escape-hatch ratchet counts
 * every occurrence.
 */
export const g = globalThis as unknown as Record<string, unknown>;

export function installAudioMocks(
  mockOpts: AudioMockOptions = {},
): AudioMockContext & { restore: () => void } {
  const origAudioContext = globalThis.AudioContext;
  const origAudioWorkletNode = globalThis.AudioWorkletNode;
  const nav = g.navigator as { mediaDevices?: { getUserMedia?: unknown } } | undefined;
  const origGetUserMedia = nav?.mediaDevices?.getUserMedia;

  let _lastContext: MockAudioContext;
  const _contexts: MockAudioContext[] = [];
  const _workletNodes: MockAudioWorkletNode[] = [];
  let _lastAudioConstraints: MediaTrackConstraints | undefined;

  g.AudioContext = class extends MockAudioContext {
    constructor(opts?: { sampleRate?: number }) {
      super(
        mockOpts.forceSampleRate === undefined ? opts : { sampleRate: mockOpts.forceSampleRate },
      );
      _lastContext = this;
      _contexts.push(this);
    }
  };

  g.AudioWorkletNode = class extends MockAudioWorkletNode {
    constructor(ctx: MockAudioContext, name: string, options?: unknown) {
      super(ctx, name, options);
      _workletNodes.push(this);
    }
  };

  if (nav && !nav.mediaDevices) nav.mediaDevices = {};
  if (nav?.mediaDevices) {
    nav.mediaDevices.getUserMedia = (constraints?: MediaStreamConstraints) => {
      _lastAudioConstraints = constraints?.audio as MediaTrackConstraints | undefined;
      return Promise.resolve({
        getTracks: () => [
          {
            stopped: false,
            stop() {
              this.stopped = true;
            },
          },
        ],
      });
    };
  }

  return {
    lastContext: () => _lastContext,
    contexts: () => _contexts,
    workletNodes: () => _workletNodes,
    lastAudioConstraints: () => _lastAudioConstraints,
    restore() {
      globalThis.AudioContext = origAudioContext;
      globalThis.AudioWorkletNode = origAudioWorkletNode;
      if (origGetUserMedia && nav?.mediaDevices) {
        nav.mediaDevices.getUserMedia = origGetUserMedia;
      }
    },
  };
}

export function findWorkletNode(nodes: MockAudioWorkletNode[], name: string): MockAudioWorkletNode {
  const node = nodes.find((n) => n.name === name);
  if (!node) throw new Error(`No worklet node named "${name}"`);
  return node;
}

/**
 * Fire a worklet node's `onprocessorerror`, the way the browser does when a
 * processor throws. `MockAudioWorkletNode` does not declare the handler, so
 * reaching it needs a cast — keep it at this one seam; the escape-hatch
 * ratchet counts every occurrence.
 */
export function crashWorklet(node: MockAudioWorkletNode): void {
  (node as unknown as { onprocessorerror: () => void }).onprocessorerror();
}

/**
 * A `MediaStream` carrying just the tracks a test cares about. The real
 * interface has far more surface than `getUserMedia` consumers touch, so the
 * stand-in needs a cast — keep it at this one seam.
 */
export function fakeMediaStream(...tracks: { stop: () => void }[]): MediaStream {
  return { getTracks: () => tracks } as unknown as MediaStream;
}
