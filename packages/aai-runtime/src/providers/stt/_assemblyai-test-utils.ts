// Copyright 2025 the AAI authors. MIT license.
/**
 * Shared harness for the AssemblyAI STT adapter's two suites — `assemblyai.test.ts`
 * (turn events, fixture replay, frame coalescing) and
 * `assemblyai-connect-params.test.ts` (everything that goes on the connect URL).
 *
 * The split exists because the combined file crossed the 700-line test cap; the
 * seam is "what the adapter does with a live stream" against "what it dials
 * with", and both halves need the same fake transcriber.
 *
 * The fake reaches the adapter through `openAssemblyAI`'s `createTranscriber`
 * seam ({@link fakeTranscriber}), so no suite replaces the `assemblyai` module.
 */

import type { BeginEvent, StreamingTranscriberParams } from "assemblyai";
import type {
  AssemblyAISession,
  CreateAssemblyAITranscriber,
  openAssemblyAI,
} from "./assemblyai.ts";

/** A listener as the fake stores it: fired with whatever a test hands `_fire`. */
type Listener = (...args: unknown[]) => void;

/** The stand-in {@link fakeTranscriber} hands the adapter. */
export interface FakeTranscriber {
  readonly params: Record<string, unknown>;
  readonly updateConfigurationCalls: Record<string, unknown>[];
  /** How many times the adapter asked the service to end the turn now. */
  forceEndpointCalls: number;
  readonly sentAudio: ArrayBufferLike[];
  /** Generic so it fits each of the SDK's typed `on` overloads. */
  on<A extends unknown[]>(ev: string, fn: (...args: A) => void): void;
  connect(): Promise<BeginEvent>;
  close(): Promise<void>;
  sendAudio(_data: ArrayBufferLike): void;
  updateConfiguration(config: Record<string, unknown>): void;
  forceEndpoint(): void;
  _fire(ev: string, ...args: unknown[]): void;
}

function makeFakeTranscriber(params: StreamingTranscriberParams): FakeTranscriber {
  const listeners = new Map<string, Listener[]>();
  return {
    params,
    updateConfigurationCalls: [],
    forceEndpointCalls: 0,
    sentAudio: [],
    on<A extends unknown[]>(ev: string, fn: (...args: A) => void) {
      const arr = listeners.get(ev) ?? [];
      // The test names the event and supplies its payload, so the payload is
      // the listener's by construction.
      arr.push((...args) => fn(...(args as A)));
      listeners.set(ev, arr);
    },
    async connect() {
      const begin: BeginEvent = { type: "Begin", id: "mock-sess", expires_at: 0 };
      this._fire("open", begin);
      return begin;
    },
    async close() {
      /* no-op */
    },
    sendAudio(data: ArrayBufferLike) {
      this.sentAudio.push(data);
    },
    updateConfiguration(config: Record<string, unknown>) {
      this.updateConfigurationCalls.push(config);
    },
    forceEndpoint() {
      this.forceEndpointCalls += 1;
    },
    _fire(ev, ...args) {
      for (const fn of listeners.get(ev) ?? []) fn(...args);
    },
  };
}

/** Each transcriber {@link fakeTranscriber} built, by the handle the adapter holds. */
const fakes = new WeakMap<object, FakeTranscriber>();

/** The `createTranscriber` every suite opens with: a {@link FakeTranscriber}, recorded. */
export const fakeTranscriber: CreateAssemblyAITranscriber = (_apiKey, params) => {
  const fake = makeFakeTranscriber(params);
  fakes.set(fake, fake);
  return fake;
};

/** The {@link FakeTranscriber} behind a session opened through {@link fakeTranscriber}. */
export function fakeOf(session: AssemblyAISession): FakeTranscriber {
  const fake = fakes.get(session._transcriber);
  if (!fake) throw new Error("session was not opened through fakeTranscriber");
  return fake;
}

/**
 * Open a session against {@link fakeTranscriber}. Takes the opener factory rather than
 * importing it, so a suite that reloads the module graph (the `AAI_DEBUG`
 * trace test) can pass its own freshly imported copy.
 */
export async function openSessionWith(
  open: typeof openAssemblyAI,
  providerOpts: Parameters<typeof openAssemblyAI>[0],
  openOpts: Partial<Parameters<ReturnType<typeof openAssemblyAI>["open"]>[0]> = {},
): Promise<AssemblyAISession> {
  const controller = new AbortController();
  return (await open(providerOpts, fakeTranscriber).open({
    sampleRate: 16_000,
    apiKey: "k",
    signal: controller.signal,
    ...openOpts,
  })) as AssemblyAISession;
}
