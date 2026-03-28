// Copyright 2025 the AAI authors. MIT license.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { flush, installMockWebSocket } from "@alexkroman1/aai/testing";
import { batch, signal } from "@preact/signals";
import { createVoiceSession, type VoiceSession } from "./session.ts";
import { createSessionControls, type SessionSignals } from "./signals.ts";
import type { AgentState, ChatMessage, SessionError, ToolCallInfo } from "./types.ts";

export { flush, installMockWebSocket, MockWebSocket } from "@alexkroman1/aai/testing";

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Test helpers assign incomplete mocks to global properties (e.g. a plain
// {origin} for `location` instead of the full DOM Location interface).
// The double-cast is required because `typeof globalThis & Record<string, unknown>`
// still enforces the full DOM types on existing properties.
const g = globalThis as unknown as Record<string, unknown>;

export function installMockLocation(origin = "http://localhost:3000") {
  const had = "location" in globalThis;
  if (!had) g.location = { origin };
  return {
    restore() {
      if (!had) delete g.location;
    },
  };
}

export class MockMediaStreamTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

export class MockMediaStream {
  #tracks = [new MockMediaStreamTrack()];
  getTracks() {
    return this.#tracks;
  }
}

export class MockMessagePort {
  onmessage: ((e: MessageEvent) => void) | null = null;
  posted: unknown[] = [];
  postMessage(data: unknown, _transfer?: Transferable[]) {
    this.posted.push(data);
  }
  simulateMessage(data: unknown) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
}

export class MockAudioWorkletNode {
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
  createMediaStreamSource(_stream: MockMediaStream) {
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
  workletNodes: () => MockAudioWorkletNode[];
};

export function installAudioMocks(): AudioMockContext & { restore: () => void } {
  const origAudioContext = globalThis.AudioContext;
  const origAudioWorkletNode = globalThis.AudioWorkletNode;
  const nav = g.navigator as { mediaDevices?: { getUserMedia?: unknown } } | undefined;
  const origGetUserMedia = nav?.mediaDevices?.getUserMedia;

  let _lastContext: MockAudioContext;
  const _workletNodes: MockAudioWorkletNode[] = [];

  g.AudioContext = class extends MockAudioContext {
    constructor(opts?: { sampleRate?: number }) {
      super(opts);
      _lastContext = this;
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
    nav.mediaDevices.getUserMedia = () => Promise.resolve(new MockMediaStream());
  }

  return {
    lastContext: () => _lastContext,
    workletNodes: () => _workletNodes,
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

export function setupSignalsEnv() {
  const mock = installMockWebSocket();
  const loc = installMockLocation();
  const session = createVoiceSession({
    platformUrl: "http://localhost:3000",
    reactiveFactory: signal,
    batch,
  });
  const signals = createSessionControls(session);

  return {
    mock,
    session,
    signals,
    async connect() {
      session.connect();
      await flush();
    },
    send(msg: Record<string, unknown>) {
      mock.lastWs?.simulateMessage(JSON.stringify(msg));
    },
    restore() {
      mock.restore();
      loc.restore();
    },
  };
}

// ─── Fixture replay helpers ──────────────────────────────────────────────────

/** Load a JSON fixture from __fixtures__/. */
export function loadFixture<T = Record<string, unknown>[]>(name: string): T {
  return JSON.parse(readFileSync(resolve(import.meta.dirname, "__fixtures__", name), "utf-8"));
}

/**
 * Replay a fixture session through the signals test environment.
 * Sends each message via the mock WebSocket, yielding between messages.
 */
export async function replayFixture(
  env: ReturnType<typeof setupSignalsEnv>,
  fixtureName: string,
): Promise<void> {
  const messages = loadFixture(fixtureName);
  for (const msg of messages) {
    env.send(msg);
    await flush();
  }
}

export function createMockSignals(
  overrides?: Partial<{
    state: AgentState;
    messages: ChatMessage[];
    userUtterance: string | null;
    error: SessionError | null;
    started: boolean;
    running: boolean;
  }>,
): SessionSignals {
  const mockSession = {
    state: signal<AgentState>(overrides?.state ?? "disconnected"),
    messages: signal<ChatMessage[]>(overrides?.messages ?? []),
    toolCalls: signal<ToolCallInfo[]>([]),
    userUtterance: signal<string | null>(overrides?.userUtterance ?? null),
    agentUtterance: signal<string | null>(null),
    error: signal<SessionError | null>(overrides?.error ?? null),
    disconnected: signal<{ intentional: boolean } | null>(null),
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
    [Symbol.dispose]() {
      /* noop */
    },
  } satisfies VoiceSession;

  const signals: SessionSignals = {
    session: mockSession,
    started: signal<boolean>(overrides?.started ?? false),
    running: signal<boolean>(overrides?.running ?? true),
    dispose() {
      /* noop */
    },
    [Symbol.dispose]() {
      /* noop */
    },
    start() {
      signals.started.value = true;
      signals.running.value = true;
    },
    toggle() {
      signals.running.value = !signals.running.value;
    },
    reset() {
      /* noop */
    },
  };

  return signals;
}
