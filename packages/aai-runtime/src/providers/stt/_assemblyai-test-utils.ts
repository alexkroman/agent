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
 * `vi.mock` is hoisted above imports, so a suite cannot hand
 * {@link assemblyAIModuleMock} to it directly — call it from an ASYNC factory
 * that `await import`s this module:
 *
 * ```ts no-check
 * vi.mock("assemblyai", async () => {
 *   const { assemblyAIModuleMock } = await import("./_assemblyai-test-utils.ts");
 *   return assemblyAIModuleMock();
 * });
 * ```
 */

import type { AssemblyAISession, openAssemblyAI } from "./assemblyai.ts";

/** The stand-in the mocked `assemblyai` module hands the adapter. */
export interface FakeTranscriber {
  readonly params: Record<string, unknown>;
  readonly updateConfigurationCalls: Record<string, unknown>[];
  readonly sentAudio: ArrayBufferLike[];
  on(ev: string, fn: (...args: unknown[]) => void): void;
  connect(): Promise<void>;
  close(): Promise<void>;
  sendAudio(_data: ArrayBufferLike): void;
  updateConfiguration(config: Record<string, unknown>): void;
  _fire(ev: string, ...args: unknown[]): void;
}

function makeFakeTranscriber(params: Record<string, unknown>): FakeTranscriber {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    params,
    updateConfigurationCalls: [],
    sentAudio: [],
    on(ev, fn) {
      const arr = listeners.get(ev) ?? [];
      arr.push(fn);
      listeners.set(ev, arr);
    },
    async connect() {
      this._fire("open", { type: "Begin", id: "mock-sess", expires_at: 0 });
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
    _fire(ev, ...args) {
      for (const fn of listeners.get(ev) ?? []) fn(...args);
    },
  };
}

/** The module shape `vi.mock("assemblyai", …)` must return. */
export function assemblyAIModuleMock(): { AssemblyAI: new () => unknown } {
  return {
    AssemblyAI: class {
      streaming = {
        transcriber: (params: Record<string, unknown>): FakeTranscriber =>
          makeFakeTranscriber(params),
      };
    },
  };
}

/**
 * The mocked `assemblyai` module hands the adapter a {@link FakeTranscriber},
 * but `AssemblyAISession._transcriber` is typed as the real SDK's
 * `StreamingTranscriber` — structurally unrelated shapes, so the narrowing
 * needs a cast. Keep it to this one seam rather than repeating it at every
 * assertion; the escape-hatch ratchet counts each occurrence.
 */
export function fakeOf(session: AssemblyAISession): FakeTranscriber {
  return session._transcriber as unknown as FakeTranscriber;
}

/**
 * Open a session against the mocked SDK. Takes the opener factory rather than
 * importing it, so a suite that reloads the module graph (the `AAI_DEBUG`
 * trace test) can pass its own freshly imported copy.
 */
export async function openSessionWith(
  open: typeof openAssemblyAI,
  providerOpts: Parameters<typeof openAssemblyAI>[0],
  openOpts: Partial<Parameters<ReturnType<typeof openAssemblyAI>["open"]>[0]> = {},
): Promise<AssemblyAISession> {
  const controller = new AbortController();
  return (await open(providerOpts).open({
    sampleRate: 16_000,
    apiKey: "k",
    signal: controller.signal,
    ...openOpts,
  })) as AssemblyAISession;
}
