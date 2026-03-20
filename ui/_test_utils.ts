// Copyright 2025 the AAI authors. MIT license.

import { signal } from "@preact/signals";
import { render } from "preact";
import { vi } from "vitest";
import { DOMParser, installDomShim } from "./_dom_shim.ts";
import { createVoiceSession, type VoiceSession } from "./session.ts";
import { createSessionControls, type SessionSignals } from "./signals.ts";
import type { AgentState, Message, SessionError, ToolCallInfo } from "./types.ts";

export { installMockWebSocket, MockWebSocket } from "../sdk/_mock_ws.ts";

import { installMockWebSocket } from "../sdk/_mock_ws.ts";

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const HTML = `<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>`;

const g = globalThis as unknown as Record<string, unknown>;

export function setupDOM() {
  installDomShim();
  const doc = new DOMParser().parseFromString(HTML, "text/html");
  if (!doc) throw new Error("Failed to parse HTML document");
  g.document = doc;
  return doc as unknown as Document;
}

export function getContainer(): Element {
  const el = globalThis.document.querySelector("#app");
  if (!el) throw new Error("Expected #app element to exist in document");
  return el;
}

// Ensure document exists at import time for modules that need DOM globals.
setupDOM();

export function flush(): Promise<void> {
  return new Promise<void>((r) => queueMicrotask(r));
}

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
  disconnect() {}
}

export class MockAudioNode {
  connected: (MockAudioNode | MockAudioWorkletNode)[] = [];
  connect(dest: MockAudioNode | MockAudioWorkletNode) {
    this.connected.push(dest);
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
    this.sampleRate = opts?.sampleRate ?? 44100;
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

/**
 * Install Web Audio API mocks on globalThis and run `fn`.
 * All mocks are restored after `fn` completes.
 */
export function withAudioMocks(
  fn: (ctx: AudioMockContext) => void | Promise<void>,
): () => Promise<void> {
  return async () => {
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

    try {
      await fn({
        lastContext: () => _lastContext,
        workletNodes: () => _workletNodes,
      });
    } finally {
      globalThis.AudioContext = origAudioContext;
      globalThis.AudioWorkletNode = origAudioWorkletNode;
      if (origGetUserMedia && nav?.mediaDevices) {
        nav.mediaDevices.getUserMedia = origGetUserMedia;
      }
    }
  };
}

export function findWorkletNode(nodes: MockAudioWorkletNode[], name: string): MockAudioWorkletNode {
  const node = nodes.find((n) => n.name === name);
  if (!node) throw new Error(`No worklet node named "${name}"`);
  return node;
}

/**
 * Set up a DOM + FakeTime environment, run `fn`, then clean up.
 * Used by component tests that need a container and timer control.
 */
export function withDOM(fn: (container: Element) => void | Promise<void>): () => Promise<void> {
  return async () => {
    vi.useFakeTimers();
    setupDOM();
    const container = getContainer();
    try {
      await fn(container);
    } finally {
      render(null, container);
      await vi.advanceTimersByTimeAsync(100);
      vi.useRealTimers();
    }
  };
}

/**
 * Set up DOM + mock WebSocket, run `fn`, then clean up.
 * Used by mount tests.
 */
export function withMountEnv(
  fn: (mock: ReturnType<typeof installMockWebSocket>) => void | Promise<void>,
): () => Promise<void> {
  return async () => {
    setupDOM();
    const mock = installMockWebSocket();
    try {
      await fn(mock);
    } finally {
      const app = globalThis.document.querySelector("#app");
      if (app) render(null, app as Element);
      await delay(0);
      mock.restore();
    }
  };
}

/**
 * Set up mock WebSocket + location + session + signals, run `fn`, clean up.
 * Used by signals tests.
 */
export function withSignalsEnv(
  fn: (ctx: {
    mock: ReturnType<typeof installMockWebSocket>;
    session: VoiceSession;
    signals: ReturnType<typeof createSessionControls>;
    connect: () => Promise<void>;
    send: (msg: Record<string, unknown>) => void;
  }) => void | Promise<void>,
): () => Promise<void> {
  return async () => {
    const mock = installMockWebSocket();
    const loc = installMockLocation();
    const session = createVoiceSession({
      platformUrl: "http://localhost:3000",
    });
    const signals = createSessionControls(session);
    try {
      await fn({
        mock,
        session,
        signals,
        async connect() {
          session.connect();
          await flush();
        },
        send(msg) {
          mock.lastWs?.simulateMessage(JSON.stringify(msg));
        },
      });
    } finally {
      mock.restore();
      loc.restore();
    }
  };
}

export function createMockSignals(
  overrides?: Partial<{
    state: AgentState;
    messages: Message[];
    userUtterance: string | null;
    error: SessionError | null;
    started: boolean;
    running: boolean;
  }>,
): SessionSignals {
  const mockSession = {
    state: signal<AgentState>(overrides?.state ?? "disconnected"),
    messages: signal<Message[]>(overrides?.messages ?? []),
    toolCalls: signal<ToolCallInfo[]>([]),
    userUtterance: signal<string | null>(overrides?.userUtterance ?? null),
    agentUtterance: signal<string | null>(null),
    error: signal<SessionError | null>(overrides?.error ?? null),
    disconnected: signal<{ intentional: boolean } | null>(null),
    connect() {},
    cancel() {},
    resetState() {},
    reset() {},
    disconnect() {},
    [Symbol.dispose]() {},
  } satisfies VoiceSession;

  const signals: SessionSignals = {
    session: mockSession,
    started: signal<boolean>(overrides?.started ?? false),
    running: signal<boolean>(overrides?.running ?? true),
    dispose() {},
    [Symbol.dispose]() {},
    start() {
      signals.started.value = true;
      signals.running.value = true;
    },
    toggle() {
      signals.running.value = !signals.running.value;
    },
    reset() {},
  };

  return signals;
}
