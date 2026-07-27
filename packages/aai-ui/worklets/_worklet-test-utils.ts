// Copyright 2026 the AAI authors. MIT license.
/**
 * Test harness for the AudioWorklet processors.
 *
 * The worklets ship as source strings (they are compiled into a Blob URL at
 * runtime), so they can't be imported. This evaluates a worklet's source with
 * stand-ins for the AudioWorkletGlobalScope bindings it relies on —
 * `AudioWorkletProcessor`, `registerProcessor`, and the `sampleRate` global —
 * and hands back a live processor instance plus a fake `MessagePort`, so the
 * DSP can be exercised directly instead of only grepped for substrings.
 */

/** One message the processor posted back to the main thread. */
export type PostedMessage = { event: string; buffer?: ArrayBuffer };

/** Fake `MessagePort`: records outbound posts, injects inbound messages. */
export type FakePort = {
  /** Every message the processor has posted, oldest first. */
  readonly posted: PostedMessage[];
  /** Buffers from `{ event: "chunk" }` posts, in order. */
  chunks(): ArrayBuffer[];
  /** Deliver a message to the processor as the main thread would. */
  send(data: unknown): void;
  postMessage(data: PostedMessage, transfer?: unknown[]): void;
  onmessage: ((e: { data: unknown }) => void) | null;
};

/** A processor instance: `process()` plus the fields the worklets expose. */
export type WorkletProcessor = {
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    params?: Record<string, Float32Array>,
  ): boolean;
} & Record<string, unknown>;

function createFakePort(): FakePort {
  const posted: PostedMessage[] = [];
  return {
    posted,
    chunks: () =>
      posted.filter((m) => m.event === "chunk" && m.buffer).map((m) => m.buffer as ArrayBuffer),
    postMessage(data) {
      posted.push(data);
    },
    onmessage: null,
    send(data) {
      this.onmessage?.({ data });
    },
  };
}

/**
 * Evaluate a worklet source string and instantiate the processor it registers.
 *
 * @param source - The worklet source (the default export's underlying string).
 * @param processorName - Name passed to `registerProcessor` inside the source.
 * @param processorOptions - Value exposed as `options.processorOptions`.
 * @param sampleRateHz - Value of the `sampleRate` global inside the worklet.
 */
export function instantiateWorklet(
  source: string,
  processorName: string,
  processorOptions: Record<string, unknown> = {},
  sampleRateHz = 48_000,
): { processor: WorkletProcessor; port: FakePort } {
  const port = createFakePort();

  class FakeAudioWorkletProcessor {
    port = port;
  }

  const registered = new Map<string, new (options: unknown) => WorkletProcessor>();
  const register = (name: string, ctor: new (options: unknown) => WorkletProcessor): void => {
    registered.set(name, ctor);
  };

  const run = new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", source) as (
    base: unknown,
    reg: typeof register,
    rate: number,
  ) => void;
  run(FakeAudioWorkletProcessor, register, sampleRateHz);

  const Ctor = registered.get(processorName);
  if (!Ctor) throw new Error(`Worklet did not register a processor named "${processorName}"`);
  return { processor: new Ctor({ processorOptions }), port };
}

/** Read a worklet's source string off disk (the module exports a Blob URL). */
export async function readWorkletSource(fileName: string): Promise<string> {
  const [fs, path] = await Promise.all([import("node:fs/promises"), import("node:path")]);
  return fs.readFile(path.resolve(import.meta.dirname, fileName), "utf-8");
}

/**
 * Extract the backtick-delimited worklet source from its module file. The
 * module wraps the source in a template literal, so `\`` escapes are undone.
 */
export async function loadWorkletSource(fileName: string): Promise<string> {
  const file = await readWorkletSource(fileName);
  const start = file.indexOf("`");
  const end = file.lastIndexOf("`");
  if (start === -1 || end <= start) throw new Error(`No template literal found in ${fileName}`);
  return file.slice(start + 1, end).replaceAll("\\`", "`");
}

/** Build one render quantum of Float32 input for `process()`. */
export function quantum(samples: number[]): Float32Array[][] {
  return [[Float32Array.from(samples)]];
}

/** Encode float samples in [-1, 1] as little-endian PCM16 bytes. */
export function pcm16Bytes(samples: number[]): Uint8Array {
  const out = new Int16Array(samples.length);
  for (const [i, s] of samples.entries()) {
    const clamped = Math.max(-1, Math.min(1, s));
    out[i] = clamped < 0 ? clamped * 0x80_00 : clamped * 0x7f_ff;
  }
  const bytes = new Uint8Array(out.buffer);
  // The worklets expect little-endian on the wire; swap if the test host isn't.
  if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) {
    for (let i = 0; i < bytes.length; i += 2) {
      const lo = bytes[i] as number;
      bytes[i] = bytes[i + 1] as number;
      bytes[i + 1] = lo;
    }
  }
  return bytes;
}
