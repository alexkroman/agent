// Copyright 2026 the AAI authors. MIT license.
/**
 * The `traceparent` this platform already emits, read as an OTel parent context.
 *
 * ## Why this is not `W3CTraceContextPropagator`
 *
 * `@opentelemetry/core` ships one, and taking it would be one line. It would
 * also put a SECOND parser of the same header in the same process, and the two
 * answer different questions about the same bytes: `_trace-context.ts` pins
 * version `00` and rejects both all-zero ids, where a spec-following parser
 * takes a higher version and parses the first two fields anyway.
 *
 * That difference is not academic here, because both readings are USED. The id
 * `guestTrace` puts on `withReserved`'s log lines comes from ours; the id on the
 * span an operator finds in their collector would come from theirs. On any
 * header the two read differently the two ids diverge — a log line and a span
 * describing one request under two different trace ids, which is strictly worse
 * than exporting no span at all, because it is silently wrong rather than
 * absent. The whole reason to export spans over the ids we already log is that
 * an operator can pivot between them.
 *
 * So the parse is imported (`parseTraceparent`, on
 * `@alexkroman1/aai-runtime/internal`) and this module is only the OTel shape
 * around it. `tracing.test.ts` pins the agreement directly — the exported span's
 * trace id against `traceIdOf` on the same header — so the claim is a test
 * rather than this paragraph.
 *
 * ## What it does NOT carry
 *
 * `tracestate` is neither read nor written. It is vendor-specific key/value
 * baggage that nothing in this system produces or consumes, and propagating a
 * field nobody sets would be inventing a contract; the same goes for `baggage`,
 * which is a separate propagator entirely. If a deployment ever puts a
 * collector-side sampler in front of this that needs one, it joins here rather
 * than in a second propagator, so there is still one place that knows what a
 * request's trace context is.
 *
 * @module
 */

import { parseTraceparent } from "@alexkroman1/aai-runtime/internal";
import {
  type Context,
  type TextMapGetter,
  type TextMapPropagator,
  type TextMapSetter,
  TraceFlags,
  trace,
} from "@opentelemetry/api";

/** The one header this propagator reads and writes. */
export const TRACEPARENT_HEADER = "traceparent";

/**
 * The `traceparent` for a span context, in the grammar `newTraceparent` mints.
 *
 * Spelled here rather than imported because the runtime's minter takes no
 * arguments — it exists to create a fresh id, and this needs to serialize an id
 * that already exists. The GRAMMAR is what has to match, and the parser above is
 * what enforces that: a header this writes must be one `parseTraceparent`
 * accepts, which `tracing-propagator.test.ts` asserts as a round trip.
 */
function formatTraceparent(traceId: string, spanId: string, flags: number): string {
  return `00-${traceId}-${spanId}-${(flags & 0xff).toString(16).padStart(2, "0")}`;
}

/**
 * A W3C trace-context propagator over this repo's own `traceparent` grammar.
 *
 * Registered globally by {@link startTracing} and used by `@hono/otel`'s
 * middleware, which calls `propagation.extract` with the request's header record
 * before it opens the server span — so a guest's platform RPC and the handler
 * that serves it land in ONE trace rather than two.
 */
export const aaiTraceparentPropagator: TextMapPropagator = {
  fields: () => [TRACEPARENT_HEADER],

  inject(context: Context, carrier: unknown, setter: TextMapSetter): void {
    const spanContext = trace.getSpanContext(context);
    // `isSpanContextValid` would be the library's own test; the two conditions
    // it checks (non-zero trace and span ids) are exactly what the parser above
    // refuses, so testing the ids keeps one definition of "valid" in the
    // process rather than two that agree today.
    if (!(spanContext?.traceId && spanContext.spanId)) return;
    const header = formatTraceparent(
      spanContext.traceId,
      spanContext.spanId,
      spanContext.traceFlags,
    );
    if (parseTraceparent(header) === undefined) return;
    setter.set(carrier, TRACEPARENT_HEADER, header);
  },

  extract(context: Context, carrier: unknown, getter: TextMapGetter): Context {
    const raw = getter.get(carrier, TRACEPARENT_HEADER);
    // A getter may answer a list — a header sent twice. Two `traceparent`s is a
    // caller that cannot say which trace this is, so neither is taken: guessing
    // would attach the request to an arbitrary one of two traces, and the
    // request keeps a trace of its own instead.
    const header = typeof raw === "string" ? raw : undefined;
    const parsed = parseTraceparent(header);
    if (!parsed) return context;
    return trace.setSpanContext(context, {
      traceId: parsed.traceId,
      spanId: parsed.spanId,
      // Only the low bit is defined, and `TraceFlags.SAMPLED` is it. Masking
      // rather than passing the byte through keeps an unknown future flag from
      // reaching a sampler that would read it as sampled.
      traceFlags: parsed.flags & TraceFlags.SAMPLED,
      // The span is the CALLER's, in another process. Exporters read this to
      // decide the span is a remote parent rather than one they are holding.
      isRemote: true,
    });
  },
};
