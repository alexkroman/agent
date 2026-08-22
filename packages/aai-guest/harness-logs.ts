// Copyright 2026 the AAI authors. MIT license.
/**
 * The guest's own output, kept where the guest can serve it.
 *
 * ## Why the buffer lives HERE
 *
 * A guest's stdout has always reached the platform — `startGuestLogging`
 * (aai-server/warm-harness.ts) drains both streams into the host log the moment
 * the process exists. What it could never reach is the person who wrote the
 * tool: the host log is Modal's, and the studio has no way in.
 *
 * The obvious fix — buffer it host-side, next to the relay — does not work on
 * this platform, and the reason is worth writing down because it is the same
 * reason `sandbox-directory.ts` exists. A sandbox is resident on ONE replica,
 * and a replica that does not hold it never proxies for the one that does: it
 * looks the sandbox up and dials the sandbox's own tunnel (`findPeerSession`).
 * So a buffer in host memory is readable from exactly one of N replicas, chosen
 * by which one happened to spawn the guest. A buffer in the GUEST is reachable
 * from all of them, by the same URL everything else uses.
 *
 * ## What that costs, said plainly
 *
 * The buffer dies with the sandbox — an agent guest self-exits on idle, so this
 * is "what my agent printed recently", never "what it printed last Tuesday".
 * And a bundle that throws at LOAD exits before this server binds, so its
 * stderr is only in the host log; the studio reports that case through
 * `previewError` instead. Durable log storage is a different problem with a
 * different answer (see "Where the logs go" — it is not another Postgres
 * database per project).
 *
 * ## Capture is a `write` tee, not a console patch
 *
 * `console.log`, `console.error`, an uncaught exception's trace, and a
 * dependency writing straight to the fd all funnel through
 * `process.stdout.write` / `process.stderr.write`. Patching the two writers
 * catches every one; patching `console` catches only the first two — and the
 * traces are the half worth reading. The original write still runs, so the host
 * relay and Modal's own log see exactly what they saw before.
 *
 * @module
 */

import { createLogBuffer, type LogBuffer, type LogStream } from "@alexkroman1/aai-runtime";

/** What a `write` callback is handed. */
type WriteCallback = (err?: Error | null) => void;

/**
 * `Writable.write`, spelled with Node's own overload pair.
 *
 * Both are needed: `write(chunk, cb)` and `write(chunk, encoding, cb)` are
 * distinct call shapes, and a single signature typed with a
 * `BufferEncoding | WriteCallback` second parameter is not what
 * `process.stdout` declares — assigning the real stream to it fails.
 */
type StreamWriter = {
  write(chunk: string | Uint8Array, cb?: WriteCallback): boolean;
  write(chunk: string | Uint8Array, encoding?: BufferEncoding, cb?: WriteCallback): boolean;
};

/** The process streams this module tees. A seam so a test can pass fakes. */
export type CapturedStreams = Record<LogStream, StreamWriter>;

/** The real pair, as the default. */
function processStreams(): CapturedStreams {
  return { stdout: process.stdout, stderr: process.stderr };
}

/**
 * Tee both process streams into `buffer`, and return the undo.
 *
 * Idempotence is the caller's job — `main()` calls this once, before anything
 * else can write. Installing twice would double every line.
 */
export function installLogCapture(
  buffer: LogBuffer,
  streams: CapturedStreams = processStreams(),
): () => void {
  const restore: (() => void)[] = [];
  const decoder = new TextDecoder();
  for (const name of ["stdout", "stderr"] as const) {
    const target = streams[name];
    const original = target.write.bind(target);
    target.write = (
      chunk: string | Uint8Array,
      encodingOrCb?: BufferEncoding | WriteCallback,
      cb?: WriteCallback,
    ): boolean => {
      // Recording must never be able to break the process's own output, so the
      // real write happens first and the capture is wrapped. A decoder throwing
      // on a malformed chunk would otherwise swallow the line entirely.
      //
      // The branch is Node's own overload dispatch, not a formality: forwarding
      // a callback in the encoding position silently drops it, so the writer
      // never learns its write drained.
      const wrote =
        typeof encodingOrCb === "function"
          ? original(chunk, encodingOrCb)
          : original(chunk, encodingOrCb, cb);
      try {
        buffer.append(name, typeof chunk === "string" ? chunk : decoder.decode(chunk));
      } catch {
        // A line lost to a decode failure is not worth a crashed guest.
      }
      return wrote;
    };
    restore.push(() => {
      target.write = original;
    });
  }
  return () => {
    for (const undo of restore) undo();
  };
}

/**
 * The process-wide buffer, created on first use.
 *
 * A module-level singleton rather than a value threaded from `main()`, because
 * the two things that need it are at opposite ends of the harness — the capture
 * installs before anything else runs, and the manage handler is built deep
 * inside agent mode. Threading it would put a logs parameter through every
 * constructor in between for no other reason.
 */
let processBuffer: LogBuffer | undefined;

/** The buffer this process captures into. */
export function guestLogBuffer(): LogBuffer {
  processBuffer ??= createLogBuffer();
  return processBuffer;
}

/**
 * Install capture into {@link guestLogBuffer}. Call once, as early as possible.
 * Returns the undo, which only tests use.
 */
export function captureGuestOutput(streams?: CapturedStreams): () => void {
  return installLogCapture(guestLogBuffer(), streams);
}

/** Reset the singleton. Tests only — a process has exactly one output. */
export function resetGuestLogBuffer(): void {
  processBuffer = undefined;
}

/**
 * A `?after=`/`?limit=` pair off a manage request's query.
 *
 * Both are tolerant: an absent, malformed or negative `after` reads from the
 * oldest line held, which is what a first poll wants and what a client sending
 * garbage should get rather than an error. The buffer caps `limit` itself.
 */
export function parseLogQuery(query: URLSearchParams): {
  after: number;
  limit: number | undefined;
} {
  // `Number(null)` is 0, not NaN — so an ABSENT `after` must be rejected before
  // the numeric check, or a first poll reads as "already saw line 0" and the
  // pane silently misses the guest's first line.
  const after = numeric(query.get("after"));
  const limit = numeric(query.get("limit"));
  return {
    after: after !== undefined && after >= 0 ? after : -1,
    limit: limit !== undefined && limit > 0 ? limit : undefined,
  };
}

/** A query value as an integer, or undefined for absent/malformed. */
function numeric(raw: string | null): number | undefined {
  if (raw === null || raw === "") return undefined;
  const value = Number(raw);
  return Number.isInteger(value) ? value : undefined;
}
