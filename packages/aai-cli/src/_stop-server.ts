// Copyright 2026 the AAI authors. MIT license.

/**
 * Stop what `aai start` started: close the server — which shuts the runtime
 * down too, so there is no separate `runtime.shutdown()` — then flush tracing
 * WHETHER OR NOT the close succeeded, so the spans that explain a failed
 * shutdown are exported rather than dropped with the process. Rejects with the
 * close's error; `shutdown` never rejects, so telemetry cannot turn a clean
 * stop into a failed one.
 *
 * Its own module so the signal listener in `start.ts` stays one call: the
 * listener is only reachable by signalling a bound server, and this is the
 * part of it worth a test.
 */
export async function stopProjectServer(
  server: { close(): Promise<void> },
  tracing: { shutdown(): Promise<void> } | undefined,
): Promise<void> {
  try {
    await server.close();
  } finally {
    await tracing?.shutdown();
  }
}
