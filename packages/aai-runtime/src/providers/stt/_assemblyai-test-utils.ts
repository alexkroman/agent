// Copyright 2025 the AAI authors. MIT license.
/**
 * Shared harness for the AssemblyAI STT adapter's two suites — `assemblyai.test.ts`
 * (turn events, fixture replay, frame coalescing) and
 * `assemblyai-connect-params.test.ts` (everything that goes on the connect URL).
 *
 * The seam is "what the adapter does with a live stream" against "what it dials
 * with", and both halves need the same fake transcriber.
 *
 * The fake reaches the adapter through `openAssemblyAI`'s `createTranscriber`
 * seam ({@link fakeTranscriber}), so no suite replaces the `assemblyai` module.
 */

import { EventEmitter } from "node:events";
import type { BeginEvent, StreamingTranscriberParams } from "assemblyai";
import { vi } from "vitest";
import type {
  AssemblyAISession,
  CreateAssemblyAITranscriber,
  openAssemblyAI,
} from "./assemblyai.ts";

/**
 * The stand-in {@link fakeTranscriber} hands the adapter: an `EventEmitter`
 * whose wire methods are spies, so a spec asserts on calls.
 */
export class FakeTranscriber extends EventEmitter {
  readonly updateConfiguration = vi.fn<(config: Record<string, unknown>) => void>();
  /** The adapter asking the service to end the turn now. */
  readonly forceEndpoint = vi.fn<() => void>();
  readonly sendAudio = vi.fn<(data: ArrayBufferLike) => void>();
  readonly close = vi.fn(async () => undefined);

  readonly params: Record<string, unknown>;

  constructor(params: StreamingTranscriberParams) {
    super();
    this.params = params;
  }

  async connect(): Promise<BeginEvent> {
    const begin: BeginEvent = { type: "Begin", id: "mock-sess", expires_at: 0 };
    this.emit("open", begin);
    return begin;
  }

  /** Every audio frame the adapter forwarded, in order. */
  get sentAudio(): ArrayBufferLike[] {
    return this.sendAudio.mock.calls.map(([data]) => data);
  }

  _fire(ev: string, ...args: unknown[]): void {
    this.emit(ev, ...args);
  }
}

/** The `createTranscriber` every suite opens with: a {@link FakeTranscriber}. */
export const fakeTranscriber: CreateAssemblyAITranscriber = (_apiKey, params) =>
  new FakeTranscriber(params);

/** The {@link FakeTranscriber} behind a session opened through {@link fakeTranscriber}. */
export function fakeOf(session: AssemblyAISession): FakeTranscriber {
  const fake = session._transcriber;
  if (!(fake instanceof FakeTranscriber)) {
    throw new Error("session was not opened through fakeTranscriber");
  }
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
