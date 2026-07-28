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
      postMessage(data: unknown, _transfer?: unknown[]) {
        posted.push(data);
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
