// Copyright 2025 the AAI authors. MIT license.

import type { VoiceIOOptions } from "./audio.ts";
import type { SessionCore, SessionSnapshot } from "./session-core.ts";
import type { AgentState, ChatMessage, SessionError, ToolCallInfo } from "./types.ts";

type MockSessionCore = SessionCore & { update(partial: Partial<SessionSnapshot>): void };

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
  }>,
): MockSessionCore {
  let snapshot: SessionSnapshot = {
    state: overrides?.state ?? "disconnected",
    messages: overrides?.messages ?? [],
    toolCalls: overrides?.toolCalls ?? [],
    customEvents: [],
    userTranscript: overrides?.userTranscript ?? null,
    agentTranscript: overrides?.agentTranscript ?? null,
    error: overrides?.error ?? null,
    started: overrides?.started ?? false,
    running: overrides?.running ?? true,
  };

  const subscribers = new Set<() => void>();
  function notify() {
    for (const sub of subscribers) sub();
  }
  function noop() {
    /* noop */
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(cb) {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
    connect: noop,
    cancel: noop,
    resetState: noop,
    reset: noop,
    disconnect: noop,
    start() {
      snapshot = { ...snapshot, started: true, running: true };
      notify();
    },
    toggle() {
      snapshot = { ...snapshot, running: !snapshot.running };
      notify();
    },
    update(partial) {
      snapshot = { ...snapshot, ...partial };
      notify();
    },
    [Symbol.dispose]: noop,
  };
}

export function voiceOpts(overrides?: Partial<VoiceIOOptions>): VoiceIOOptions {
  return {
    sttSampleRate: 16_000,
    ttsSampleRate: 24_000,
    captureWorkletSrc: "cap",
    playbackWorkletSrc: "play",
    onMicData: () => {
      /* noop */
    },
    ...overrides,
  };
}

class MockMessagePort {
  onmessage: ((e: MessageEvent) => void) | null = null;
  posted: unknown[] = [];
  postMessage(data: unknown) {
    this.posted.push(data);
  }
  simulateMessage(data: unknown) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
}

class MockAudioNode {
  connected: (MockAudioNode | MockAudioWorkletNode)[] = [];
  connect(dest: MockAudioNode | MockAudioWorkletNode) {
    this.connected.push(dest);
  }
  disconnect() {
    /* noop */
  }
}

class MockAudioWorkletNode {
  port = new MockMessagePort();
  connected: MockAudioNode[] = [];
  name: string;
  options: unknown;
  constructor(_ctx: MockAudioContext, name: string, options?: unknown) {
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
  workletNodes: () => MockAudioWorkletNode[];
};

export function installAudioMocks(): AudioMockContext & { restore: () => void } {
  const g = globalThis as unknown as Record<string, unknown>;
  const origAudioContext = globalThis.AudioContext;
  const origAudioWorkletNode = globalThis.AudioWorkletNode;
  const nav = g.navigator as { mediaDevices?: { getUserMedia?: unknown } } | undefined;
  const origGetUserMedia = nav?.mediaDevices?.getUserMedia;

  let lastContext: MockAudioContext;
  const workletNodes: MockAudioWorkletNode[] = [];

  g.AudioContext = class extends MockAudioContext {
    constructor(opts?: { sampleRate?: number }) {
      super(opts);
      lastContext = this;
    }
  };

  g.AudioWorkletNode = class extends MockAudioWorkletNode {
    constructor(ctx: MockAudioContext, name: string, options?: unknown) {
      super(ctx, name, options);
      workletNodes.push(this);
    }
  };

  if (nav && !nav.mediaDevices) nav.mediaDevices = {};
  if (nav?.mediaDevices) {
    nav.mediaDevices.getUserMedia = () =>
      Promise.resolve({
        getTracks: () => [
          {
            stopped: false,
            stop() {
              this.stopped = true;
            },
          },
        ],
      });
  }

  return {
    lastContext: () => lastContext,
    workletNodes: () => workletNodes,
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
