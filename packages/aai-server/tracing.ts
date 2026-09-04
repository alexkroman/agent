// Copyright 2026 the AAI authors. MIT license.
/**
 * OTLP span export for the platform's HTTP surfaces, OFF unless an operator
 * configures a collector.
 *
 * ## What this finishes
 *
 * `aai-runtime/_trace-context.ts` mints a W3C `traceparent` on every guest→
 * platform RPC, and justified the format this way: "an operator who later puts
 * an OTEL collector in front of this gets these spans for free rather than
 * having to teach it a private header." Nothing emitted a span, so nobody got
 * anything for free — what existed was a correlation id in two log lines. This
 * is the exporter that makes the sentence true, and the ids are the SAME ids:
 * the propagator is built on the runtime's own parser
 * (`tracing-propagator.ts`), so a `traceId` grepped out of a `withReserved` line
 * is a trace id an operator can paste into their collector.
 *
 * ## OFF by default, and that is a property rather than a default
 *
 * This is a voice runtime. A tracer that is always on adds work to the path a
 * turn takes, and a background flush is a timer on a process whose latency
 * budget is a person waiting for an answer. So with no collector configured,
 * **nothing is constructed** — no exporter, no provider, no processor, no timer,
 * no middleware in the request path, and no global propagator. `tracing.test.ts`
 * asserts that by handing {@link startTracing} an exporter FACTORY and checking
 * it was never called; a claim of "zero cost" that is only prose is not one.
 *
 * The gate is the presence of an endpoint, which is the one thing an operator
 * cannot forget to set if they want spans anywhere.
 *
 * ## The vocabulary is OTel's, not ours
 *
 * `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`),
 * `OTEL_EXPORTER_OTLP_HEADERS` (or the traces-specific one) and
 * `OTEL_SERVICE_NAME`. An operator should not have to learn our spelling for a
 * thing that already has one, and there is no vendor anywhere in this module —
 * any OTLP/HTTP collector is a legal target, including a vendor's own ingest
 * endpoint if that is where a deployment points it.
 *
 * **The endpoint variables are READ here only as a predicate.** The URL, the
 * headers and the timeout are resolved by the exporter itself, which already
 * implements the parts of the spec that are easy to get subtly wrong — that
 * `OTEL_EXPORTER_OTLP_ENDPOINT` gets `/v1/traces` appended while the
 * signal-specific variable is used verbatim, and the `key=value,key=value`
 * header grammar. Re-deriving either here would be a second answer to a question
 * the library already answers, which is the mistake `tracing-propagator.ts`
 * exists to avoid one layer down.
 *
 * ## Where the exporter's own bytes go
 *
 * The OTLP/HTTP exporter dials the collector with Node's `http`/`https`, not
 * through `aai-runtime`'s egress pools. That is deliberate and narrow:
 * `guard-invariants` rule 29 governs the RUNTIME's egress — a guest's calls to
 * the platform and to a tenant's buckets, where connection pooling and the H2
 * measurement in `_egress-fetch.ts` decide whether a run survives — and this is
 * the platform process talking to an operator-owned collector on an
 * operator-configured host. No tenant traffic goes near it, no guest can reach
 * it, and it carries no tenant credential. If a deployment ever needs to shape
 * that traffic, `httpAgentOptions` on the exporter config is the seam, not a
 * `fetch`.
 *
 * ## What emits the spans, and what is NOT covered
 *
 * Every span here comes from `@hono/otel`'s middleware — the HTTP surface, one
 * SERVER span per request. **Nothing in this package hand-instruments anything**,
 * and in particular nothing wraps an LLM call: the AI SDK emits its own
 * structured telemetry for model calls, steps and tool calls, and re-deriving
 * that by hand would be a second instrumentation of one thing.
 *
 * **But that telemetry cannot be bridged from HERE, and the reason is the
 * process rather than the wiring.** `registerTelemetry` (from `ai`) arms the
 * SDK's instrumentation for the process that calls the model, and neither
 * platform package makes such a call: `aai-server` and `aai-studio-server`
 * declare no dependency on `ai` and import nothing from it — the only textual
 * match across both is the word `ctx.generate` inside a prompt preamble. The
 * model calls happen in the GUEST: the voice pipeline through the worker
 * bundle's own `aai-runtime`, the studio coding agent through
 * `aai-guest/studio-agent.ts`. A `registerTelemetry` call in this process would
 * arm a hook nothing in it can ever fire — a mechanism that reports success and
 * checks nothing, which is the shape this repo keeps paying for.
 *
 * Three measured facts for whoever wires the guest half, so they are not
 * rediscovered (probed against the installed `ai@7.0.90`):
 *
 * - **The registry is `globalThis.AI_SDK_TELEMETRY_INTEGRATIONS`, read PER
 *   CALL.** So it crosses module copies — the same property `Symbol.for` buys
 *   the workflow run context — which matters because a deployed guest holds two
 *   copies of `ai` (the harness's and the worker bundle's). One registration in
 *   the harness would cover both, where a module-local registry would cover
 *   neither reliably.
 * - **Registration IS the enablement.** A call with no
 *   `experimental_telemetry` fires the integrations exactly as one with
 *   `{ isEnabled: true }` does; the per-call option changes nothing once an
 *   integration is registered.
 * - **Unregistered costs nothing.** With no integration the global is
 *   `undefined` and the `ai:telemetry` diagnostics channel reports
 *   `hasSubscribers === false`, so the SDK runs straight through — the same
 *   off-by-default property this module holds for the exporter.
 *
 * What that costs is a decision rather than a wiring step, which is why it is
 * not taken here: it puts the OTel packages into `aai-guest/dist/harness.mjs`,
 * baked into the snapshot image and therefore on the cold-start path of every
 * sandbox, and it needs the collector endpoint carried through `agentBootEnv`.
 *
 * The rest of the stack — the platform RPC hop, the workflow journal, the
 * STT/TTS sockets — is covered by nothing here beyond the HTTP span that
 * contains it, and would be hand-written when somebody wants it.
 *
 * ## A collector that is down may not cost a request
 *
 * Spans leave through a {@link BatchSpanProcessor}, so `span.end()` appends to a
 * buffer and returns; the export happens later on an UNREF'd timer, and an
 * export that fails is dropped by the processor rather than raised at whoever
 * was being served. {@link Tracing.forceFlush} and {@link Tracing.shutdown}
 * swallow and LOG a failure for the same reason one level up — a broken
 * collector must not be able to fail a process shutdown, which is a real outage
 * in exchange for telemetry nobody is reading anyway.
 *
 * @module
 */

import { errorMessage } from "@alexkroman1/aai";
import { httpInstrumentationMiddleware } from "@hono/otel";
import { propagation, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import type { MiddlewareHandler } from "hono";
import pTimeout from "p-timeout";
import { createLogger } from "./logger.ts";
import { aaiTraceparentPropagator } from "./tracing-propagator.ts";

const log = createLogger("tracing");

/**
 * The standard variables that name a collector. Either one arms this.
 *
 * Exported so the spec asserts the same strings an operator sets, rather than
 * its own copy of them — the failure `EGRESS_RPC_HTTP2_ENV` names one package
 * over.
 */
export const OTEL_ENDPOINT_ENVS = [
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
] as const;

/** The standard variable naming this service in every exported span. */
export const OTEL_SERVICE_NAME_ENV = "OTEL_SERVICE_NAME";

/**
 * What a span says it came from when the operator did not say.
 *
 * A name rather than nothing, because OTel's own fallback is
 * `unknown_service:node` and a collector holding several of those cannot tell
 * this platform's spans from anything else the operator runs.
 */
export const DEFAULT_SERVICE_NAME = "aai-platform";

/**
 * How long a flush or a shutdown may spend talking to the collector.
 *
 * The provider's own default is 30 seconds, which on the shutdown path is
 * `SHUTDOWN_TEARDOWN_TIMEOUT_MS`-sized: a collector that has gone away would
 * hold the process past the platform's stop grace and earn it a SIGKILL, and a
 * SIGKILL truncates every open live stream. Telemetry is never worth that, so
 * the deadline here is small enough to be invisible beside the teardown it
 * follows, and exceeding it drops whatever was still buffered.
 */
export const TRACING_DRAIN_TIMEOUT_MS = 2000;

/** A started tracer, and the two things a caller may do to it. */
export type Tracing = {
  /** Push whatever is buffered now. Never rejects — see the module doc. */
  forceFlush: () => Promise<void>;
  /** Flush and release. Never rejects, and is idempotent. */
  shutdown: () => Promise<void>;
};

export type TracingOptions = {
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Builds the exporter, and is called ONLY when a collector is configured.
   *
   * A factory rather than an instance so a spec can prove the disabled case
   * constructs nothing: an instance would already exist by the time this
   * function decided not to use it, which is exactly the claim under test.
   */
  createExporter?: () => SpanExporter;
};

/**
 * The collector this environment names, or `undefined` for "no tracing".
 *
 * Whitespace-only counts as unset: an empty variable is how a deployment
 * template spells "not configured", and taking it literally would arm the
 * exporter against an endpoint of `""`.
 */
export function tracingEndpoint(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of OTEL_ENDPOINT_ENVS) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * The HTTP middleware, or `undefined` when tracing is off.
 *
 * **It starts the provider itself, and that is not a convenience.**
 * `@hono/otel` resolves the tracer ONCE, at middleware construction, from
 * whatever provider is global at that moment — so a middleware built before
 * {@link startTracing} binds the no-op provider and drops every span for the
 * life of the process, silently. Both entry points build their apps BEFORE
 * `startService`, so requiring the caller to order the two correctly would be
 * requiring exactly the order they do not use. {@link startTracing} is
 * idempotent, so `startService` still asks for the handle it needs to flush on
 * shutdown and gets this one.
 */
export function tracingMiddleware(
  env: NodeJS.ProcessEnv = process.env,
): MiddlewareHandler | undefined {
  if (!startTracing({ env })) return undefined;
  return httpInstrumentationMiddleware({
    serviceName: serviceName(env),
    // Metrics are a separate pipeline with no exporter wired here, so the
    // in-flight counter would feed a no-op meter at a cost per request.
    captureActiveRequests: false,
  });
}

function serviceName(env: NodeJS.ProcessEnv): string {
  return env[OTEL_SERVICE_NAME_ENV]?.trim() || DEFAULT_SERVICE_NAME;
}

/** The one started tracer, so a second `startService` in one process is a no-op. */
let started: Tracing | undefined;

/**
 * Start span export if this environment names a collector; otherwise do nothing.
 *
 * Idempotent by process: the second call hands back the first one's handle
 * rather than installing a second provider, because the tracer provider and the
 * propagator are GLOBAL and two of them would mean one of the two apps' spans
 * going to a provider nothing shuts down.
 */
export function startTracing(opts: TracingOptions = {}): Tracing | undefined {
  const env = opts.env ?? process.env;
  const endpoint = tracingEndpoint(env);
  if (!endpoint) return undefined;
  if (started) return started;

  const exporter = (opts.createExporter ?? (() => new OTLPTraceExporter()))();
  const provider = new BasicTracerProvider({
    resource: defaultResource().merge(resourceFromAttributes({ "service.name": serviceName(env) })),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  // The globals rather than `provider.register()`: that helper also installs
  // OTel's own composite propagator, which would put a second `traceparent`
  // parser in the process — see `tracing-propagator.ts` for why that is the one
  // thing this must not do.
  trace.setGlobalTracerProvider(provider);
  propagation.setGlobalPropagator(aaiTraceparentPropagator);

  const guard = (what: string, run: () => Promise<void>) => async () => {
    try {
      await pTimeout(run(), {
        milliseconds: TRACING_DRAIN_TIMEOUT_MS,
        message: `tracing ${what} exceeded ${TRACING_DRAIN_TIMEOUT_MS}ms`,
      });
    } catch (err: unknown) {
      // The namespace already says `tracing`, so the message does not.
      log.warn(`${what} failed`, { error: errorMessage(err) });
    }
  };
  started = {
    forceFlush: guard("flush", () => provider.forceFlush()),
    shutdown: guard("shutdown", async () => {
      // Cleared FIRST so a shutdown that throws still leaves the module able to
      // start again — a handle nobody can replace is worse than a leaked
      // provider on a process that is exiting anyway.
      started = undefined;
      trace.disable();
      propagation.disable();
      await provider.shutdown();
    }),
  };
  // The endpoint and the service name only. The headers carry the collector's
  // credential and are never logged.
  log.info("enabled", { endpoint, service: serviceName(env) });
  return started;
}
