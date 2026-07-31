// Copyright 2025 the AAI authors. MIT license.

/**
 * Test utilities for React-based component tests.
 * No dependency on @preact/signals.
 */

import type { SessionCore, SessionSnapshot } from "./session-core.ts";
import type { AgentState, ChatMessage, SessionError, ToolCallInfo } from "./types.ts";

/**
 * Create a mock SessionCore for React component tests.
 *
 * Returns a `SessionCore`-compatible object with mutable snapshot. Call
 * `core.update(partial)` to mutate the snapshot and notify subscribers,
 * triggering React re-renders.
 */
export function createMockSessionCore(
  overrides?: Partial<{
    state: AgentState;
    messages: ChatMessage[];
    toolCalls: ToolCallInfo[];
    userTranscript: string | null;
    agentTranscript: string | null;
    error: SessionError | null;
    started: boolean;
    running: boolean;
    recording: boolean;
    apiUrl: string;
  }>,
): SessionCore & { update(partial: Partial<SessionSnapshot>): void } {
  let snapshot: SessionSnapshot = {
    state: overrides?.state ?? "disconnected",
    contentVersion: 0,
    messages: overrides?.messages ?? [],
    toolCalls: overrides?.toolCalls ?? [],
    customEvents: [],
    userTranscript: overrides?.userTranscript ?? null,
    agentTranscript: overrides?.agentTranscript ?? null,
    error: overrides?.error ?? null,
    started: overrides?.started ?? false,
    running: overrides?.running ?? true,
    recording: overrides?.recording ?? false,
    apiUrl: overrides?.apiUrl ?? "ws://test.local/websocket",
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

export class MockGainNode extends MockAudioNode {
  gain = {
    value: 1,
    setTargetAtTime(value: number, _startTime: number, _tc: number) {
      this.value = value;
    },
  };
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
  createGain() {
    return new MockGainNode();
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

const g = globalThis as unknown as Record<string, unknown>;

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
