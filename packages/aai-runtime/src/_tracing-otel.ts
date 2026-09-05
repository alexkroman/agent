// Copyright 2026 the AAI authors. MIT license.
/**
 * The OTel half of the guest's span export: the provider, and the AI SDK
 * telemetry bridge.
 *
 * Reached ONLY through `tracing.ts`'s dynamic `import()`, so nothing here
 * is evaluated on a guest with no collector configured. That module carries the
 * env gate, the credential note and the argument for the split; this one
 * carries what the spans contain.
 *
 * ## Metadata only, and there is no other setting
 *
 * Every attribute is copied field by field from an allow-list. Nothing walks an
 * event, nothing serializes one, and there is no redaction step — content is
 * absent because it is never read.
 *
 * That is not defensiveness. Measured against `ai@7.0.90`, the events carry the
 * whole conversation: `messages` on `onStart` / `onStepStart` /
 * `onLanguageModelCallStart`, and `content`, `text`, `toolCalls`, `toolResults`
 * on `onLanguageModelCallEnd` / `onStepEnd` / `onEnd`; a tool event carries
 * `messages` plus `toolOutput.output`. `recordInputs` and `recordOutputs` are
 * NOT filters — they are advisory fields the SDK passes THROUGH to the
 * integration, defaulting to `true`. So an integration that serialized its
 * event would ship every transcript to the collector, and a deny-list would do
 * it again the first time the SDK added a field nobody had denied.
 *
 * **Content capture is deliberately not offered at all.** The brief allowed it
 * behind an explicit opt-in; the safer answer was available, which is that
 * there is no code path here that can emit a prompt, a completion, a transcript,
 * a tool argument or a tool result. So the safe setting is not the default —
 * it is the only setting, and `tracing.test.ts` asserts it against a real
 * `generateText` whose prompt, completion, tool argument and tool result are
 * distinctive strings. Adding the opt-in later means adding the code that reads
 * those fields, which is exactly the review that should be hard to skip.
 *
 * ## The span tree, and why the inner spans are DURATION-DERIVED
 *
 * `onStart` / `onEnd` bracket one generation and share a stable `callId`, so
 * that pair becomes a real span held open across the operation — one entry of
 * live state, ended by the matching `onEnd`.
 *
 * The inner events cannot be paired that way, which is why
 * `onStepStart`, `onLanguageModelCallStart` and `onToolExecutionStart` are
 * deliberately NOT subscribed: measured, all three report the SAME `callId` as
 * the operation, so a map keyed on it would collide across the steps of one
 * generation and end the wrong span. Their ends carry their own durations
 * instead (`performance.stepTimeMs`, `performance.responseTimeMs`,
 * `toolExecutionMs`), so each inner span is created AT ITS END with
 * `startTime = end - duration`. That is exact to the SDK's own measurement,
 * needs no pairing state, and cannot leak a span when an end never arrives —
 * so a start handler would be a no-op that only looked like coverage.
 *
 * @module
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { isRecord } from "@alexkroman1/aai/utils";
import {
  type Context,
  context as otelContext,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  type TextMapGetter,
  type TextMapPropagator,
  type TextMapSetter,
  TraceFlags,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { registerTelemetry, type Telemetry } from "ai";
import pTimeout from "p-timeout";
import { parseTraceparent } from "./_trace-context.ts";

/**
 * A started tracer.
 *
 * Declared here rather than imported from `tracing.ts`, and the SERVICE
 * NAME arrives resolved for the same reason: that module reaches this one
 * through a dynamic `import()`, so anything this module imported back would be
 * a cycle — which Biome refuses, and which would also give a bundler an excuse
 * to hoist this graph out of the lazy chunk the whole design rests on. Nothing
 * here imports the gate; the gate passes down what it has already read.
 */
export type TracingHandle = {
  forceFlush: () => Promise<void>;
  shutdown: () => Promise<void>;
  /**
   * Make an inbound request's `traceparent` the ambient context for the rest of
   * that request. Handed BACK to `tracing.ts`, which owns the seam the
   * harness calls — see that module's `setRequestTraceAdopter`.
   */
  adoptRequestTrace: (headers: Record<string, string | string[] | undefined>) => void;
};

/**
 * How long a flush or a shutdown may spend talking to the collector.
 *
 * A guest is torn down on a schedule it does not control — the idle reaper, the
 * sandbox timeout, a platform terminate — so a drain that outlives the process
 * is ordinary rather than exceptional. Small enough to be invisible against a
 * boot, and exceeding it drops whatever was buffered.
 */
const DRAIN_TIMEOUT_MS = 2000;

/** The one header the propagator reads and writes. */
const TRACEPARENT_HEADER = "traceparent";

/**
 * The same `traceparent` grammar the platform hop already speaks.
 *
 * Built on `parseTraceparent` from `@alexkroman1/aai-runtime/internal` — the
 * runtime's own parser, the one that mints the header on every platform RPC and
 * the one `aai-server` reads the id off for its log lines. A library propagator
 * would be a second parser of one header, and the two disagree (this grammar
 * pins version `00` and rejects both all-zero ids), which would put a different
 * trace id on a span than on the log line describing the same request.
 *
 * The guest may not import `aai-server`, so this is a second copy of the OTel
 * SHIM around that parser, never of the grammar — `konsistent`'s boundary
 * leaves no shared private home for it, and the grammar (the half that can
 * drift) still has exactly one implementation.
 *
 * Note what it does NOT yet buy: nothing forwards a `traceparent` INTO a guest
 * today — `guest-forward.ts` is an allow-list and does not carry it — so these
 * spans root their own traces. Installing the propagator is what makes a parent
 * be honoured the day one arrives.
 */
export const traceparentPropagator: TextMapPropagator = {
  fields: () => [TRACEPARENT_HEADER],
  inject(ctx: Context, carrier: unknown, setter: TextMapSetter): void {
    const sc = trace.getSpanContext(ctx);
    if (!(sc?.traceId && sc.spanId)) return;
    const flags = (sc.traceFlags & 0xff).toString(16).padStart(2, "0");
    const header = `00-${sc.traceId}-${sc.spanId}-${flags}`;
    if (parseTraceparent(header) === undefined) return;
    setter.set(carrier, TRACEPARENT_HEADER, header);
  },
  extract(ctx: Context, carrier: unknown, getter: TextMapGetter): Context {
    const raw = getter.get(carrier, TRACEPARENT_HEADER);
    const parsed = parseTraceparent(typeof raw === "string" ? raw : undefined);
    if (!parsed) return ctx;
    return trace.setSpanContext(ctx, {
      traceId: parsed.traceId,
      spanId: parsed.spanId,
      traceFlags: parsed.flags & TraceFlags.SAMPLED,
      isRemote: true,
    });
  },
};

/** A finite number, or nothing — an absent field must not become `NaN`. */
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A non-empty string, or nothing. */
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Read one property off an event.
 *
 * The events are a union of a dozen shapes across four operation families, and
 * the bridge wants the same six or seven fields off whichever arrived. Reading
 * them structurally is what keeps this an allow-list of NAMES rather than a
 * cast per event type — and a cast would be the wrong tool twice over, since it
 * would also stop reporting the day a field's type changed.
 */
function field(event: unknown, key: string): unknown {
  return isRecord(event) ? event[key] : undefined;
}

/** Read `outer.inner` off an event. */
function nested(event: unknown, outer: string, inner: string): unknown {
  return field(field(event, outer), inner);
}

/**
 * THE ALLOW-LIST. Every attribute a model span may carry is named here.
 *
 * Read it as the security boundary it is: a field absent from this function
 * cannot reach the collector. The names follow OpenTelemetry's `gen_ai.*`
 * semantic conventions so an operator's existing dashboards find them.
 */
function metadataOf(event: unknown): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  const put = (key: string, value: string | number | undefined) => {
    if (value !== undefined) out[key] = value;
  };
  put("gen_ai.request.model", str(field(event, "modelId")));
  put("gen_ai.system", str(field(event, "provider")));
  put("gen_ai.response.finish_reason", str(field(event, "finishReason")));
  put("gen_ai.response.id", str(field(event, "responseId")));
  // `usage` on a call or step, `totalUsage` on the operation's own end.
  const usage = field(event, "usage") ?? field(event, "totalUsage");
  put("gen_ai.usage.input_tokens", num(field(usage, "inputTokens")));
  put("gen_ai.usage.output_tokens", num(field(usage, "outputTokens")));
  put("gen_ai.usage.total_tokens", num(field(usage, "totalTokens")));
  put("ai.step", num(field(event, "stepNumber")));
  put("ai.function_id", str(field(event, "functionId")));
  put("ai.operation_id", str(field(event, "operationId")));
  return out;
}

/** The tool half of the allow-list: a NAME, and an outcome KIND. */
function toolMetadataOf(event: unknown): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  const name = str(nested(event, "toolCall", "toolName"));
  if (name !== undefined) out["gen_ai.tool.name"] = name;
  // `tool-result` or `tool-error` — the OUTCOME, never the output.
  const outcome = str(nested(event, "toolOutput", "type"));
  if (outcome !== undefined) out["gen_ai.tool.outcome"] = outcome;
  return out;
}

/**
 * The trace context an inbound request adopted, for the rest of that request.
 *
 * ## Why this exists ALONGSIDE the registered context manager
 *
 * `AsyncLocalStorageContextManager` is registered above and is what makes
 * `otelContext.active()` work generally — but its interface is
 * `active`/`with`/`bind`/`enable`/`disable` and exposes no `enterWith`, and the
 * seam this has to serve has nothing to wrap: the harness's `request` hook
 * returns a BOOLEAN and `/workflows/*` falls through it to the runtime's own
 * router, so by the time the model call happens the hook has long returned.
 * `with(ctx, fn)` needs that `fn` and there is none.
 *
 * So the adoption is stored here and consulted as the FIRST parent candidate,
 * with `otelContext.active()` behind it — one precedence rule, stated once, in
 * `onStart`. Nitro's integration is the same shape from the other end: it
 * registers a real context manager AND still hangs the span on its event
 * object, shipping a `defineTracedEventHandler` to stop the ambient context
 * being lost. An explicit carrier is where this road ends either way.
 */
const requestTrace = new AsyncLocalStorage<Context>();

/**
 * Read a header off Node's `IncomingHttpHeaders`.
 *
 * Node lower-cases inbound header names and gives a repeated one as an array;
 * `traceparent` may legally appear once, so a duplicate is a malformed request
 * rather than a merge — take the first and let the grammar reject it if it is
 * not one.
 */
const incomingHeaderGetter: TextMapGetter<Record<string, string | string[] | undefined>> = {
  keys: (carrier) => Object.keys(carrier),
  get: (carrier, key) => carrier[key.toLowerCase()],
};

/** One live operation span, keyed by the `callId` that brackets it. */
type LiveOperation = { span: Span; ctx: Context };

/**
 * How many generations may be in flight before the oldest is abandoned.
 *
 * `onEnd` removes its own entry, so this only binds if an operation never ends
 * — a crash inside the SDK, or a stream nobody drains. Dropping the oldest
 * loses a parent link; leaving it would leak a span object per lost generation
 * for the life of a guest that is deliberately long-lived.
 */
const MAX_LIVE_OPERATIONS = 64;

export function startTracingOtel(
  /** Already resolved by the gate — see {@link TracingHandle}. */
  serviceName: string,
  /** Test seam: the real exporter dials the collector named in `process.env`. */
  createExporter: () => SpanExporter = () => new OTLPTraceExporter(),
): TracingHandle {
  const provider = new BasicTracerProvider({
    resource: defaultResource().merge(resourceFromAttributes({ "service.name": serviceName })),
    spanProcessors: [new BatchSpanProcessor(createExporter())],
  });
  trace.setGlobalTracerProvider(provider);
  // The library's own context manager, registered so `otelContext.active()`
  // means something process-wide: any OTel-aware code an agent brings — an
  // instrumented database driver, a user's own tracer — then joins the trace
  // instead of rooting beside it. It is an OPTIONAL PEER like the rest of the
  // graph, so a deployment that never enables tracing installs no
  // AsyncLocalStorage and pays nothing; only this branch constructs one.
  otelContext.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  // The `Telemetry` contract is checked HERE: `TelemetryIntegration`'s handlers all
  // take `unknown`, and this call is what proves that satisfies the SDK's own
  // per-event signatures.
  const integration: Telemetry = buildIntegration(provider.getTracer("aai-runtime"));
  registerTelemetry(integration);

  const guard = (run: () => Promise<void>) => async () => {
    try {
      await pTimeout(run(), { milliseconds: DRAIN_TIMEOUT_MS, message: "tracing drain timed out" });
    } catch {
      // A collector that is down may not fail a guest's shutdown — and the
      // guest's stdout is a TENANT-VISIBLE ring buffer (`GET /manage/logs`), so
      // a line here would put our telemetry's problems in somebody's Logs pane.
    }
  };
  return {
    forceFlush: guard(() => provider.forceFlush()),
    shutdown: guard(() => provider.shutdown()),
    adoptRequestTrace: (headers) => {
      const ctx = traceparentPropagator.extract(ROOT_CONTEXT, headers, incomingHeaderGetter);
      // Only when a PARENT really arrived: no header, or one the grammar
      // rejects, leaves `extract` returning the context it was given, and
      // pinning THAT for a request's whole subtree is a no-op that costs an
      // AsyncLocalStorage frame to express.
      if (trace.getSpanContext(ctx) === undefined) return;
      requestTrace.enterWith(ctx);
    },
  };
}

/**
 * The integration's own shape: every handler takes `unknown`.
 *
 * A handler accepting `unknown` is assignable to one accepting a specific
 * event, so `registerTelemetry` below still type-checks this against the SDK's
 * `Telemetry` — that call is the assertion. What it buys is that the handlers
 * say what they DO: they read named fields structurally off whichever of a
 * dozen event shapes arrived (see {@link field}), and typing them to one member
 * of that union would be a claim the bodies do not make.
 */
export type TelemetryIntegration = {
  onStart: (event: unknown) => void;
  onLanguageModelCallEnd: (event: unknown) => void;
  onStepEnd: (event: unknown) => void;
  onToolExecutionEnd: (event: unknown) => void;
  onEnd: (event: unknown) => void;
};

/** The integration: the operation pair, plus the four inner callbacks. */
export function buildIntegration(tracer: Tracer): TelemetryIntegration {
  const live = new Map<string, LiveOperation>();

  /** The parent for an inner span, or the root when the operation was missed. */
  const parentOf = (event: unknown): Context => {
    const id = str(field(event, "callId"));
    return (id !== undefined ? live.get(id)?.ctx : undefined) ?? ROOT_CONTEXT;
  };

  /** Create an already-finished span from the duration the event reported. */
  const closed = (name: string, event: unknown, durationMs: number | undefined): void => {
    const end = Date.now();
    tracer
      .startSpan(
        name,
        {
          kind: SpanKind.CLIENT,
          startTime: end - (durationMs ?? 0),
          attributes: metadataOf(event),
        },
        parentOf(event),
      )
      .end(end);
  };

  return {
    onStart: (event) => {
      const id = str(field(event, "callId"));
      if (id === undefined || live.has(id)) return;
      if (live.size >= MAX_LIVE_OPERATIONS) {
        const oldest = live.keys().next();
        if (!oldest.done) live.delete(oldest.value);
      }
      // The request's parent, NOT `ROOT_CONTEXT`: this is the one span in the
      // bridge that can have a parent outside the AI SDK, and hard-rooting it
      // was what kept a model call and the platform request that caused it in
      // two traces even after the header started arriving. With no request
      // context — a voice turn, a timer-driven walk — this is `ROOT_CONTEXT`
      // and the span roots exactly as it did before.
      const span = tracer.startSpan(
        `ai.generate ${str(field(event, "modelId")) ?? "unknown"}`,
        { kind: SpanKind.CLIENT, attributes: metadataOf(event) },
        requestTrace.getStore() ?? otelContext.active(),
      );
      live.set(id, { span, ctx: trace.setSpan(otelContext.active(), span) });
    },

    onLanguageModelCallEnd: (event) => {
      closed("ai.languageModelCall", event, num(nested(event, "performance", "responseTimeMs")));
    },

    onStepEnd: (event) => {
      closed("ai.step", event, num(nested(event, "performance", "stepTimeMs")));
    },

    onToolExecutionEnd: (event) => {
      const end = Date.now();
      const span = tracer.startSpan(
        `ai.toolCall ${str(nested(event, "toolCall", "toolName")) ?? "unknown"}`,
        {
          kind: SpanKind.INTERNAL,
          startTime: end - (num(field(event, "toolExecutionMs")) ?? 0),
          attributes: toolMetadataOf(event),
        },
        parentOf(event),
      );
      // The KIND of failure and never the error's message: a thrown error's
      // text is written by tool code and routinely quotes its arguments back.
      if (str(nested(event, "toolOutput", "type")) === "tool-error") {
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      span.end(end);
    },

    onEnd: (event) => {
      const id = str(field(event, "callId"));
      const entry = id !== undefined ? live.get(id) : undefined;
      if (id !== undefined) live.delete(id);
      if (!entry) return;
      entry.span.setAttributes(metadataOf(event));
      entry.span.end();
    },
  };
}
