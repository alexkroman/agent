// Copyright 2025 the AAI authors. MIT license.

/**
 * Test harness for AudioWorklet processor sources.
 *
 * The worklets ship as source strings (compiled to Blob URLs for the real
 * AudioWorklet). This harness evaluates a source string with stubbed
 * AudioWorkletGlobalScope globals so the processor's runtime behavior
 * (batching, resampling, ring buffer) can be exercised directly in unit tests.
 */

export type WorkletPort = {
  onmessage: ((e: { data: unknown }) => void) | null;
  postMessage(data: unknown, transfer?: unknown[]): void;
};

export type WorkletInstance = {
  port: WorkletPort;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
};

type WorkletCtor = new (options: { processorOptions?: Record<string, unknown> }) => WorkletInstance;

export type WorkletHarness = {
  instance: WorkletInstance;
  /** Messages the processor posted to the main thread, in order. */
  posted: unknown[];
  /** Deliver a message from the main thread to the processor. */
  sendMessage(data: unknown): void;
};

/**
 * Runaway-loop backstop. A processor that spins inside one `process()` call
 * would otherwise hang the test run until the suite timeout with no clue why;
 * this turns it into a named failure at the point of the flood.
 */
const MAX_POSTED_MESSAGES = 10_000;

/** Evaluate a worklet source string and instantiate its registered processor. */
export function instantiateWorklet(
  source: string,
  processorOptions: Record<string, unknown> = {},
  contextSampleRate = 48_000,
): WorkletHarness {
  const posted: unknown[] = [];
  class AudioWorkletProcessor {
    port: WorkletPort = {
      onmessage: null,
      postMessage(data: unknown, transfer?: unknown[]) {
        if (posted.length >= MAX_POSTED_MESSAGES) {
          throw new Error(
            `worklet posted more than ${MAX_POSTED_MESSAGES} messages — runaway loop`,
          );
        }
        // Honor the transfer list: the real postMessage DETACHES transferred
        // buffers, so a processor that reads `.length` off a view it just
        // transferred sees 0. Ignoring the list here made that class of bug
        // invisible to tests while wedging the audio thread in production.
        posted.push(
          transfer && transfer.length > 0
            ? structuredClone(data, { transfer: transfer as Transferable[] })
            : data,
        );
      },
    };
  }
  let registered: WorkletCtor | null = null;
  const registerProcessor = (_name: string, ctor: WorkletCtor): void => {
    registered = ctor;
  };
  // Evaluate the module body with AudioWorkletGlobalScope-style globals
  // injected as parameters (the source only references these three).
  const run = new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", source);
  run(AudioWorkletProcessor, registerProcessor, contextSampleRate);
  if (!registered) throw new Error("worklet source did not register a processor");
  const instance = new (registered as WorkletCtor)({ processorOptions });
  return {
    instance,
    posted,
    sendMessage(data: unknown) {
      instance.port.onmessage?.({ data });
    },
  };
}
