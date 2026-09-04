// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the `traceparent` propagator.
 *
 * The property that matters is AGREEMENT: whatever this extracts, and whatever
 * it injects, has to be the same header `parseTraceparent` reads — that is the
 * whole reason the module exists rather than a one-line
 * `W3CTraceContextPropagator`. So every case here is stated against the
 * runtime's own parser rather than against a hand-written expectation, which is
 * what makes the suite fail if the two ever come apart.
 */

import { parseTraceparent, traceIdOf } from "@alexkroman1/aai-runtime/internal";
import {
  defaultTextMapGetter,
  defaultTextMapSetter,
  ROOT_CONTEXT,
  TraceFlags,
  trace,
} from "@opentelemetry/api";
import { describe, expect, test } from "vitest";
import { aaiTraceparentPropagator, TRACEPARENT_HEADER } from "./tracing-propagator.ts";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";

const extract = (carrier: Record<string, unknown>) =>
  aaiTraceparentPropagator.extract(ROOT_CONTEXT, carrier, defaultTextMapGetter);

const inject = (traceFlags: number): Record<string, string> => {
  const carrier: Record<string, string> = {};
  const context = trace.setSpanContext(ROOT_CONTEXT, {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    traceFlags,
  });
  aaiTraceparentPropagator.inject(context, carrier, defaultTextMapSetter);
  return carrier;
};

describe("fields", () => {
  test("declares the one header it touches", () => {
    expect(aaiTraceparentPropagator.fields()).toEqual([TRACEPARENT_HEADER]);
  });
});

describe("extract", () => {
  test("makes the caller's span a REMOTE parent", () => {
    const header = `00-${TRACE_ID}-${SPAN_ID}-01`;
    const parent = trace.getSpanContext(extract({ [TRACEPARENT_HEADER]: header }));
    expect(parent).toEqual({
      traceId: traceIdOf(header),
      spanId: SPAN_ID,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    });
  });

  test("keeps only the sampled bit, so an unknown future flag cannot mean sampled", () => {
    // `fe` sets six undefined bits and leaves the sampled bit clear.
    const parent = trace.getSpanContext(
      extract({ [TRACEPARENT_HEADER]: `00-${TRACE_ID}-${SPAN_ID}-fe` }),
    );
    expect(parent?.traceFlags).toBe(TraceFlags.NONE);
  });

  test.each([
    ["absent", undefined],
    ["empty", ""],
    ["a version this grammar does not define", `01-${TRACE_ID}-${SPAN_ID}-01`],
    ["an all-zero trace id", `00-${"0".repeat(32)}-${SPAN_ID}-01`],
    ["an all-zero span id", `00-${TRACE_ID}-${"0".repeat(16)}-01`],
    ["upper-case hex, which the spec forbids", `00-${TRACE_ID.toUpperCase()}-${SPAN_ID}-01`],
    ["a truncated id", `00-${TRACE_ID.slice(0, 30)}-${SPAN_ID}-01`],
  ])("leaves the context alone for %s", (_label, header) => {
    const carrier = header === undefined ? {} : { [TRACEPARENT_HEADER]: header };
    expect(extract(carrier)).toBe(ROOT_CONTEXT);
    expect(traceIdOf(header)).toBeUndefined();
  });

  test("refuses a header sent TWICE rather than guessing which trace this is", () => {
    // A getter may answer a list. Two `traceparent`s is a caller that cannot say
    // which trace the request belongs to, so it gets one of its own.
    const carrier = {
      [TRACEPARENT_HEADER]: [`00-${TRACE_ID}-${SPAN_ID}-01`, `00-${TRACE_ID}-${SPAN_ID}-00`],
    };
    expect(extract(carrier)).toBe(ROOT_CONTEXT);
  });
});

describe("inject", () => {
  test("writes a header this repo's own parser accepts", () => {
    const header = inject(TraceFlags.SAMPLED)[TRACEPARENT_HEADER];
    expect(parseTraceparent(header)).toEqual({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      flags: TraceFlags.SAMPLED,
    });
  });

  test("round-trips through extract, so the two halves cannot drift", () => {
    const carrier = inject(TraceFlags.SAMPLED);
    expect(trace.getSpanContext(extract(carrier))).toMatchObject({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
    });
  });

  test("an unsampled span still gets a header, with the bit clear", () => {
    expect(inject(TraceFlags.NONE)[TRACEPARENT_HEADER]).toBe(`00-${TRACE_ID}-${SPAN_ID}-00`);
  });

  test("writes NOTHING when there is no span to describe", () => {
    const carrier: Record<string, string> = {};
    aaiTraceparentPropagator.inject(ROOT_CONTEXT, carrier, defaultTextMapSetter);
    expect(carrier).toEqual({});
  });

  test("writes nothing for a span context its own parser would refuse", () => {
    const carrier: Record<string, string> = {};
    const context = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: "0".repeat(32),
      spanId: SPAN_ID,
      traceFlags: TraceFlags.SAMPLED,
    });
    aaiTraceparentPropagator.inject(context, carrier, defaultTextMapSetter);
    expect(carrier).toEqual({});
  });
});
