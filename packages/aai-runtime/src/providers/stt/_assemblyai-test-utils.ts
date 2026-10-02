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

import { EventEmitter } from "node:events";
import { vi } from "vitest";
import type { AssemblyAISession, openAssemblyAI } from "./assemblyai.ts";

/**
 * The stand-in the mocked `assemblyai` module hands the adapter: an
 * `EventEmitter` whose wire methods are spies, so a spec asserts on calls.
 */
export class FakeTranscriber extends EventEmitter {
  readonly updateConfiguration = vi.fn<(config: Record<string, unknown>) => void>();
  /** The adapter asking the service to end the turn now. */
  readonly forceEndpoint = vi.fn<() => void>();
  readonly sendAudio = vi.fn<(data: ArrayBufferLike) => void>();
  readonly close = vi.fn(async () => undefined);

  readonly params: Record<string, unknown>;

  constructor(params: Record<string, unknown>) {
    super();
    this.params = params;
  }

  async connect(): Promise<void> {
    this.emit("open", { type: "Begin", id: "mock-sess", expires_at: 0 });
  }

  /** Every audio frame the adapter forwarded, in order. */
  get sentAudio(): ArrayBufferLike[] {
    return this.sendAudio.mock.calls.map(([data]) => data);
  }

  _fire(ev: string, ...args: unknown[]): void {
    this.emit(ev, ...args);
  }
}

/** The module shape `vi.mock("assemblyai", …)` must return. */
export function assemblyAIModuleMock(): { AssemblyAI: new () => unknown } {
  return {
    AssemblyAI: class {
      streaming = {
        transcriber: (params: Record<string, unknown>): FakeTranscriber =>
          new FakeTranscriber(params),
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
