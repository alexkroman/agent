// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for OTLP span export.
 *
 * Three of these are the CLAIMS the feature makes, and each is worth stating as
 * a test rather than as prose because none of them is visible in a response:
 *
 * - **Off by default constructs NOTHING.** Asserted with an exporter FACTORY
 *   that must never be called, which is the only form of the claim a test can
 *   make — an exporter instance handed in would already exist.
 * - **The exported span carries the id the LOG LINE carries.** `traceIdOf` is
 *   what `guestTrace` puts on `withReserved`'s lines, so asserting the span's
 *   trace id against that function is asserting the pivot an operator makes.
 * - **A collector that is broken cannot cost a request.** Exercised with an
 *   exporter that throws, against the real `BatchSpanProcessor`.
 *
 * Every case installs a GLOBAL tracer provider and a global propagator, so
 * every case tears its own down through `onTestFinished` — a leaked provider
 * would export one test's spans into the next one's exporter, and a leaked
 * propagator would make an unrelated suite's requests carry parents.
 */

import { traceIdOf } from "@alexkroman1/aai-runtime/internal";
import { InMemorySpanExporter, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { Hono, type MiddlewareHandler } from "hono";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { applyPlatformMiddleware } from "./app-middleware.ts";
import type { HonoEnv } from "./context.ts";
import { captureLogs } from "./test-utils.ts";
import {
  DEFAULT_SERVICE_NAME,
  OTEL_ENDPOINT_ENVS,
  OTEL_SERVICE_NAME_ENV,
  startTracing,
  type Tracing,
  tracingEndpoint,
  tracingMiddleware,
} from "./tracing.ts";

const logs = captureLogs();

/** A well-formed `traceparent` from a caller that is not this process. */
const CALLER_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const CALLER_SPAN_ID = "00f067aa0ba902b7";
const CALLER_TRACEPARENT = `00-${CALLER_TRACE_ID}-${CALLER_SPAN_ID}-01`;

/**
 * Start tracing against an in-memory exporter, registered for teardown.
 *
 * The exporter is the real one's SHAPE and the processor underneath is the real
 * `BatchSpanProcessor`, so a span reaching `getFinishedSpans()` has been through
 * the buffer and the flush an operator's spans go through.
 */
function withTracing(env: Record<string, string>): {
  tracing: Tracing;
  exporter: InMemorySpanExporter;
} {
  const exporter = new InMemorySpanExporter();
  return { tracing: started(startTracing({ env, createExporter: () => exporter })), exporter };
}

/**
 * A started tracer, insisting there is one.
 *
 * A `throw` rather than `expect.fail`: this runs in a fixture rather than in a
 * test body, which is exactly what `noMisplacedAssertion` refuses — and a
 * `undefined` here would mean the gate disagreed with the endpoint it was
 * handed, which is a setup failure and not an assertion about the subject.
 */
function started(tracing: Tracing | undefined): Tracing {
  if (!tracing) throw new Error("startTracing returned undefined for a configured endpoint");
  onTestFinished(async () => {
    await tracing.shutdown();
  });
  return tracing;
}

/** The app both entry points build, with one route to answer. */
function appWithMiddleware(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();
  applyPlatformMiddleware(app, []);
  app.get("/ok", (c) => c.text("ok"));
  return app;
}

describe("tracingEndpoint", () => {
  test("is undefined with no collector configured", () => {
    expect(tracingEndpoint({})).toBeUndefined();
  });

  test.each(OTEL_ENDPOINT_ENVS)("reads the standard variable %s", (name) => {
    expect(tracingEndpoint({ [name]: "http://collector:4318" })).toBe("http://collector:4318");
  });

  test("prefers the signal-specific endpoint over the general one", () => {
    expect(
      tracingEndpoint({
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://general:4318",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://traces:4318/v1/traces",
      }),
    ).toBe("http://traces:4318/v1/traces");
  });

  test("treats a blank variable as unset, which is how a template spells it", () => {
    expect(tracingEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "   " })).toBeUndefined();
  });
});

describe("off by default", () => {
  test("constructs no exporter when no collector is configured", () => {
    const createExporter = vi.fn(() => new InMemorySpanExporter());
    expect(startTracing({ env: {}, createExporter })).toBeUndefined();
    expect(createExporter).not.toHaveBeenCalled();
  });

  test("installs no middleware, so no span is opened at all", () => {
    expect(tracingMiddleware({})).toBeUndefined();
  });

  test("the app still serves, and the boot line is silent about tracing", async () => {
    // No `OTEL_*` in the stubbed environment, which is the deployed default.
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", undefined);
    vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", undefined);
    const res = await appWithMiddleware().request("http://localhost/ok");
    expect(await res.text()).toBe("ok");
    // The namespaced form of `log.info("enabled", …)`, which only a configured
    // deployment writes.
    expect(logs.infos()).not.toContain("tracing enabled");
  });
});

describe("enabled", () => {
  test("exports a server span for a served request", async () => {
    const { tracing, exporter } = withTracing({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
    });
    const app = new Hono();
    app.use("*", tracingMiddlewareOrFail());
    app.get("/ok", (c) => c.text("ok"));

    const res = await app.request("http://localhost/ok");
    expect(res.status).toBe(200);
    await tracing.forceFlush();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("GET /ok");
    expect(spans[0]?.attributes["http.response.status_code"]).toBe(200);
  });

  test("names the service from OTEL_SERVICE_NAME, and defaults when unset", async () => {
    const { tracing, exporter } = withTracing({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      [OTEL_SERVICE_NAME_ENV]: "platform-eu",
    });
    const app = new Hono();
    app.use("*", tracingMiddlewareOrFail());
    app.get("/ok", (c) => c.text("ok"));
    await app.request("http://localhost/ok");
    await tracing.forceFlush();

    const span = exporter.getFinishedSpans()[0];
    expect(span?.resource.attributes["service.name"]).toBe("platform-eu");
    expect(DEFAULT_SERVICE_NAME).toBe("aai-platform");
  });

  test("a second start is the SAME tracer, never a second provider", () => {
    const { tracing } = withTracing({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" });
    const second = vi.fn(() => new InMemorySpanExporter());
    expect(
      startTracing({
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" },
        createExporter: second,
      }),
    ).toBe(tracing);
    expect(second).not.toHaveBeenCalled();
  });

  test("the wiring both entry points use installs it", async () => {
    const { tracing, exporter } = withTracing({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
    });
    // `applyPlatformMiddleware` reads `process.env`, which is what the deployed
    // apps do; the stub is the same endpoint the provider above was started on.
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318");
    const res = await appWithMiddleware().request("http://localhost/ok");
    expect(await res.text()).toBe("ok");
    await tracing.forceFlush();
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(["GET /ok"]);
  });
});

describe("the span and the log line carry ONE trace id", () => {
  test("adopts the caller's traceparent rather than minting a competing id", async () => {
    const { tracing, exporter } = withTracing({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
    });
    const app = new Hono();
    app.use("*", tracingMiddlewareOrFail());
    app.get("/ok", (c) => c.text("ok"));

    await app.request(
      new Request("http://localhost/ok", { headers: { traceparent: CALLER_TRACEPARENT } }),
    );
    await tracing.forceFlush();

    const span = exporter.getFinishedSpans()[0];
    // The whole claim: the id an operator greps out of `withReserved`'s line is
    // the id on the span. `traceIdOf` is literally what writes that field.
    expect(span?.spanContext().traceId).toBe(traceIdOf(CALLER_TRACEPARENT));
    expect(span?.parentSpanContext?.spanId).toBe(CALLER_SPAN_ID);
    expect(span?.parentSpanContext?.isRemote).toBe(true);
  });

  test("a caller with no traceparent still gets a span, with a trace of its own", async () => {
    const { tracing, exporter } = withTracing({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
    });
    const app = new Hono();
    app.use("*", tracingMiddlewareOrFail());
    app.get("/ok", (c) => c.text("ok"));

    await app.request("http://localhost/ok");
    await tracing.forceFlush();

    const span = exporter.getFinishedSpans()[0];
    expect(span?.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span?.parentSpanContext).toBeUndefined();
  });

  test("a MALFORMED traceparent is refused, exactly as the log field refuses it", async () => {
    const { tracing, exporter } = withTracing({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
    });
    const app = new Hono();
    app.use("*", tracingMiddlewareOrFail());
    app.get("/ok", (c) => c.text("ok"));

    // All-zero trace id: syntactically a `traceparent`, invalid per the spec,
    // and refused by the parser both the log field and the span go through.
    const bogus = `00-${"0".repeat(32)}-${CALLER_SPAN_ID}-01`;
    expect(traceIdOf(bogus)).toBeUndefined();
    await app.request(new Request("http://localhost/ok", { headers: { traceparent: bogus } }));
    await tracing.forceFlush();

    const span = exporter.getFinishedSpans()[0];
    expect(span?.parentSpanContext).toBeUndefined();
    expect(span?.spanContext().traceId).not.toBe("0".repeat(32));
  });
});

describe("a broken collector", () => {
  /**
   * An exporter that fails the way an unreachable collector does.
   *
   * The parameters are CONTEXTUALLY typed off `SpanExporter` rather than
   * annotated: naming them would mean importing `ExportResult` and
   * `ExportResultCode` from `@opentelemetry/core`, a sixth OTel package taken as
   * a dependency for two types in one test. `1` is `ExportResultCode.FAILED`.
   */
  function failing(mode: "throw" | "report"): SpanExporter {
    return {
      export(_spans, done) {
        if (mode === "throw") throw new Error("ECONNREFUSED 127.0.0.1:4318");
        done({ code: 1, error: new Error("collector answered 503") });
      },
      shutdown: () => Promise.resolve(),
    };
  }

  test.each(["throw", "report"] as const)(
    "does not break the request path when the exporter %ss",
    async (mode) => {
      const tracing = started(
        startTracing({
          env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" },
          createExporter: () => failing(mode),
        }),
      );
      const app = new Hono();
      app.use("*", tracingMiddlewareOrFail());
      app.get("/ok", (c) => c.text("ok"));

      const res = await app.request("http://localhost/ok");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");

      // And the flush swallows it: a collector that is down may not fail a
      // shutdown, which on this platform is how a graceful stop becomes a
      // SIGKILL and truncates every open live stream.
      await expect(tracing.forceFlush()).resolves.toBeUndefined();
      expect(logs.warns()).toContain("tracing flush failed");
    },
  );

  test("shutdown is idempotent and leaves the module able to start again", async () => {
    const tracing = started(
      startTracing({
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" },
        createExporter: () => failing("throw"),
      }),
    );
    await expect(tracing.shutdown()).resolves.toBeUndefined();
    await expect(tracing.shutdown()).resolves.toBeUndefined();

    const restarted = withTracing({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" });
    expect(restarted.tracing).not.toBe(tracing);
  });
});

/**
 * The middleware, insisting it exists.
 *
 * Every caller here has already started a provider, so `undefined` would mean
 * the gate disagreed with `startTracing` — a setup failure worth naming rather
 * than one that shows up as a missing span three assertions later.
 */
function tracingMiddlewareOrFail(): MiddlewareHandler {
  const mw = tracingMiddleware({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" });
  if (!mw) throw new Error("tracingMiddleware returned undefined for a configured endpoint");
  return mw;
}
