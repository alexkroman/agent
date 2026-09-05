// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the guest's span export.
 *
 * The load-bearing one is `records no conversation content`: it drives a REAL
 * `generateText` — real tool loop, real telemetry events — whose prompt,
 * completion, tool argument and tool result are distinctive strings, and fails
 * if any of them appears anywhere in the exported spans. That is the claim the
 * feature has to keep, and it is a claim about a third-party library's event
 * payloads, so it cannot be made by reading the bridge.
 *
 * Everything here registers PROCESS-GLOBAL state — `registerTelemetry` pushes
 * onto `globalThis.AI_SDK_TELEMETRY_INTEGRATIONS` and there is no unregister,
 * and the tracer provider is global too — so every case tears both down through
 * `onTestFinished`. Without that, one case's integration reports into the next
 * case's exporter.
 */

import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { generateText, stepCountIs, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { z } from "zod";
import { buildIntegration, startTracingOtel } from "./_tracing-otel.ts";
import {
  DEFAULT_SERVICE_NAME,
  OTEL_ENDPOINT_ENVS,
  startTracing,
  startTracingDetached,
  tracingEndpoint,
} from "./tracing.ts";

/** Yield long enough for a settled dynamic import's continuations to run. */
const flushMicrotasks = (): Promise<void> => Promise.resolve();

/** Strings that exist nowhere but the conversation this test drives. */
const PROMPT = "MAGICPROMPT-my-card-is-4111111111111111";
const REPLY = "MAGICREPLY-your-balance-is-1234";
const TOOL_ARG = "MAGICARG-seattle";
const TOOL_RESULT = "MAGICRESULT-72-degrees";
const SECRETS = [PROMPT, REPLY, TOOL_ARG, TOOL_RESULT];

const CONFIGURED = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" };

/** The AI SDK's registry, which has no unregister of its own. */
type TelemetryGlobal = { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown[] | undefined };

function clearTelemetryRegistry(): void {
  (globalThis as TelemetryGlobal).AI_SDK_TELEMETRY_INTEGRATIONS = undefined;
}

function registeredIntegrations(): unknown[] | undefined {
  return (globalThis as TelemetryGlobal).AI_SDK_TELEMETRY_INTEGRATIONS;
}

/** Start the bridge against an in-memory exporter, registered for teardown. */
function withRuntimeTracing(env: Record<string, string> = CONFIGURED): {
  exporter: InMemorySpanExporter;
  /** Flush THIS provider — the global proxy exposes no `forceFlush`. */
  flush: () => Promise<void>;
} {
  clearTelemetryRegistry();
  const exporter = new InMemorySpanExporter();
  const tracing = startTracingOtel(env.OTEL_SERVICE_NAME ?? DEFAULT_SERVICE_NAME, () => exporter);
  onTestFinished(async () => {
    await tracing.shutdown();
    trace.disable();
    clearTelemetryRegistry();
  });
  return { exporter, flush: tracing.forceFlush };
}

/** A two-step generation: one tool call, then a text answer. */
async function runConversation(): Promise<void> {
  // The provider-level shapes, which are NOT flat numbers: `finishReason` is
  // `{unified, raw}` and each token count is an object. A malformed `usage`
  // here is not a type error the SDK reports — it simply reads nothing out of
  // it, and the telemetry event then carries no token counts at all, which is
  // exactly the false conclusion an earlier draft of this file drew.
  let call = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      call += 1;
      return call === 1
        ? {
            content: [
              {
                type: "tool-call" as const,
                toolCallId: "c1",
                toolName: "weather",
                input: JSON.stringify({ city: TOOL_ARG }),
              },
            ],
            finishReason: { unified: "tool-calls" as const, raw: undefined },
            usage: {
              inputTokens: { total: 11, noCache: 11, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 22, text: 22, reasoning: undefined },
            },
            warnings: [],
          }
        : {
            content: [{ type: "text" as const, text: REPLY }],
            finishReason: { unified: "stop" as const, raw: undefined },
            usage: {
              inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 7, text: 7, reasoning: undefined },
            },
            warnings: [],
          };
    },
  });

  await generateText({
    model,
    prompt: PROMPT,
    tools: {
      weather: tool({
        description: "weather by city",
        inputSchema: z.object({ city: z.string() }),
        execute: async () => TOOL_RESULT,
      }),
    },
    stopWhen: stepCountIs(3),
  });
}

/** Everything an exported span could carry, as one string. */
function serialize(spans: ReadableSpan[]): string {
  return JSON.stringify(
    spans.map((s) => ({
      name: s.name,
      attributes: s.attributes,
      status: s.status,
      events: s.events,
      resource: s.resource.attributes,
    })),
  );
}

describe("the env gate", () => {
  test("is closed with no collector configured", () => {
    expect(tracingEndpoint({})).toBeUndefined();
  });

  test.each(OTEL_ENDPOINT_ENVS)("opens on the standard variable %s", (name) => {
    expect(tracingEndpoint({ [name]: "http://c:4318" })).toBe("http://c:4318");
  });

  test("treats a blank variable as unset", () => {
    expect(tracingEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "  " })).toBeUndefined();
  });

  test("unconfigured registers NOTHING — no integration, no provider", async () => {
    clearTelemetryRegistry();
    onTestFinished(clearTelemetryRegistry);
    await expect(startTracing({})).resolves.toBeUndefined();
    // The SDK's own cost is zero while this is empty: it reads the registry per
    // call and runs straight through when there is nothing in it.
    expect(registeredIntegrations()).toBeUndefined();
  });

  test("the DETACHED start returns synchronously and never rejects", async () => {
    clearTelemetryRegistry();
    onTestFinished(clearTelemetryRegistry);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {
      // Silenced: the guest's stdout is a tenant-visible ring buffer.
    });
    // An unhandled rejection here would reach `installCrashGuards` and exit the
    // guest at boot — telemetry taking the agent down with it. The failure has
    // to be a log line, so this drives the path that produces one.
    expect(startTracingDetached({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318" })).toBe(undefined);
    // Let the dynamic import and the provider construction settle, then tear
    // the globals down — this really did start an exporter.
    await vi.waitFor(() => expect(registeredIntegrations()).toHaveLength(1));
    trace.disable();
    expect(errors).not.toHaveBeenCalled();
  });

  test("the detached start does nothing at all when unconfigured", async () => {
    clearTelemetryRegistry();
    onTestFinished(clearTelemetryRegistry);
    expect(startTracingDetached({})).toBe(undefined);
    await flushMicrotasks();
    expect(registeredIntegrations()).toBeUndefined();
  });

  test("configured registers exactly one integration", () => {
    withRuntimeTracing();
    expect(registeredIntegrations()).toHaveLength(1);
  });
});

describe("exported spans", () => {
  test("records no conversation content", async () => {
    const { exporter, flush } = withRuntimeTracing();
    await runConversation();
    await flush();

    const spans = exporter.getFinishedSpans();
    // Guard against a vacuous pass: if nothing was exported, "no content" is
    // trivially true and the assertion below means nothing.
    expect(spans.length).toBeGreaterThan(0);

    const dumped = serialize(spans);
    for (const secret of SECRETS) {
      expect.soft(dumped, `span carried ${secret.split("-")[0]}`).not.toContain(secret);
    }
  });

  test("records the METADATA, so the redaction spec is not vacuous", async () => {
    const { exporter, flush } = withRuntimeTracing();
    await runConversation();
    await flush();

    const attrs = exporter.getFinishedSpans().flatMap((s) => Object.entries(s.attributes));
    const keys = new Set(attrs.map(([k]) => k));
    // The WHOLE attribute surface of a real two-step tool-calling generation,
    // asserted exhaustively rather than by presence: this list is the other
    // half of the redaction claim, so a field quietly joining it should fail
    // here and be looked at.
    expect([...keys].toSorted()).toEqual([
      "ai.operation_id",
      "ai.step",
      "gen_ai.request.model",
      "gen_ai.response.finish_reason",
      "gen_ai.response.id",
      "gen_ai.system",
      "gen_ai.tool.name",
      "gen_ai.tool.outcome",
      "gen_ai.usage.input_tokens",
      "gen_ai.usage.output_tokens",
      "gen_ai.usage.total_tokens",
    ]);
  });

  test("names the service, defaulting when the operator did not", async () => {
    const { exporter, flush } = withRuntimeTracing();
    await runConversation();
    await flush();
    const span = exporter.getFinishedSpans()[0];
    expect(span?.resource.attributes["service.name"]).toBe(DEFAULT_SERVICE_NAME);
  });

  test("honours OTEL_SERVICE_NAME", async () => {
    const { exporter, flush } = withRuntimeTracing({
      ...CONFIGURED,
      OTEL_SERVICE_NAME: "agent-eu",
    });
    await runConversation();
    await flush();
    expect(exporter.getFinishedSpans()[0]?.resource.attributes["service.name"]).toBe("agent-eu");
  });

  test("emits a span per model call and one for the generation", async () => {
    const { exporter, flush } = withRuntimeTracing();
    await runConversation();
    await flush();
    const names = exporter.getFinishedSpans().map((s) => s.name);
    expect(names.some((n) => n.startsWith("ai.generate"))).toBe(true);
    expect(names).toContain("ai.languageModelCall");
    expect(names).toContain("ai.step");
    // The tool really executed, so its span is real rather than synthetic.
    expect(names).toContain("ai.toolCall weather");
  });

  test("the inner spans hang off the generation, in ONE trace", async () => {
    const { exporter, flush } = withRuntimeTracing();
    await runConversation();
    await flush();
    const spans = exporter.getFinishedSpans();
    const traceIds = new Set(spans.map((s) => s.spanContext().traceId));
    expect(traceIds.size).toBe(1);
  });
});

/**
 * The allow-list, driven directly.
 *
 * The `generateText` specs above prove the bridge does not leak what the SDK
 * REALLY sends; these prove it over an event carrying every field at once,
 * over an event carrying every field at once. A synthetic event is how the
 * content fields and the metadata are guaranteed to be in ONE payload, and this
 * is the A/B that fails the moment somebody copies a field across.
 */
describe("the allow-list", () => {
  /** A model-call end event with metadata AND conversation content. */
  const richEvent = {
    callId: "gen-1",
    modelId: "gpt-4o",
    provider: "openai",
    finishReason: "stop" as const,
    responseId: "resp-9",
    usage: { inputTokens: 11, outputTokens: 22, totalTokens: 33 },
    performance: { responseTimeMs: 42 },
    // Everything below is content, and none of it may reach a span. The shapes
    // are the SDK's real ones — a synthetic event that did not typecheck as one
    // would not be evidence about what the bridge does with a real one.
    messages: [{ role: "user" as const, content: PROMPT }],
    content: [{ type: "text" as const, text: REPLY }],
    text: REPLY,
    toolCalls: [
      {
        type: "tool-call" as const,
        toolCallId: "c1",
        toolName: "weather",
        input: { city: TOOL_ARG },
      },
    ],
    toolResults: [
      {
        type: "tool-result" as const,
        toolCallId: "c1",
        toolName: "weather",
        input: { city: TOOL_ARG },
        output: TOOL_RESULT,
      },
    ],
  };

  function spansFor(drive: (t: ReturnType<typeof buildIntegration>) => void) {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    onTestFinished(async () => {
      await provider.shutdown();
    });
    drive(buildIntegration(provider.getTracer("test")));
    return exporter.getFinishedSpans();
  }

  test("copies the metadata off a fully-populated event", () => {
    const [span] = spansFor((t) => t.onLanguageModelCallEnd?.(richEvent));
    expect(span?.attributes).toEqual({
      "gen_ai.request.model": "gpt-4o",
      "gen_ai.system": "openai",
      "gen_ai.response.finish_reason": "stop",
      "gen_ai.response.id": "resp-9",
      "gen_ai.usage.input_tokens": 11,
      "gen_ai.usage.output_tokens": 22,
      "gen_ai.usage.total_tokens": 33,
    });
  });

  test("copies NONE of the content beside it", () => {
    const [span] = spansFor((t) => t.onLanguageModelCallEnd?.(richEvent));
    const dumped = JSON.stringify(span?.attributes);
    for (const secret of SECRETS) {
      expect.soft(dumped, `attribute carried ${secret.split("-")[0]}`).not.toContain(secret);
    }
  });

  test("a tool span carries the NAME and the outcome, never the argument or the result", () => {
    const [span] = spansFor((t) =>
      t.onToolExecutionEnd?.({
        callId: "gen-1",
        toolExecutionMs: 7,
        toolCall: {
          type: "tool-call" as const,
          toolCallId: "c1",
          toolName: "weather",
          input: { city: TOOL_ARG },
        },
        toolOutput: {
          type: "tool-result" as const,
          toolCallId: "c1",
          toolName: "weather",
          input: { city: TOOL_ARG },
          output: TOOL_RESULT,
        },
        messages: [{ role: "user" as const, content: PROMPT }],
      }),
    );
    expect(span?.attributes).toEqual({
      "gen_ai.tool.name": "weather",
      "gen_ai.tool.outcome": "tool-result",
    });
    expect(span?.name).toBe("ai.toolCall weather");
  });

  test("a failed tool is an ERROR status and no message", () => {
    const [span] = spansFor((t) =>
      t.onToolExecutionEnd?.({
        callId: "gen-1",
        toolExecutionMs: 3,
        toolCall: {
          type: "tool-call" as const,
          toolCallId: "c1",
          toolName: "weather",
          input: {},
        },
        // A tool's thrown text routinely quotes its arguments back.
        toolOutput: {
          type: "tool-error" as const,
          toolCallId: "c1",
          toolName: "weather",
          input: {},
          error: new Error(`failed for ${TOOL_ARG}`),
        },
      }),
    );
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    // `serialize` rather than stringifying the span: a live `SpanImpl` holds a
    // back-reference to its processor and is circular.
    expect(serialize(span ? [span] : [])).not.toContain(TOOL_ARG);
    expect(span?.status.message).toBeUndefined();
  });

  test("derives the span's start from the duration the event reported", () => {
    const [span] = spansFor((t) => t.onLanguageModelCallEnd?.(richEvent));
    const ms = (hr: [number, number]) => hr[0] * 1000 + hr[1] / 1e6;
    // 42ms, within a millisecond of clock granularity.
    expect(ms(span?.endTime ?? [0, 0]) - ms(span?.startTime ?? [0, 0])).toBeCloseTo(42, 0);
  });
});

describe("a broken collector", () => {
  test("cannot break the model call", async () => {
    clearTelemetryRegistry();
    const tracing = startTracingOtel(DEFAULT_SERVICE_NAME, () => ({
      export() {
        throw new Error("ECONNREFUSED 127.0.0.1:4318");
      },
      shutdown: () => Promise.resolve(),
    }));
    onTestFinished(async () => {
      await tracing.shutdown();
      trace.disable();
      clearTelemetryRegistry();
    });
    // The whole point: a collector that is down is not the caller's problem.
    await expect(runConversation()).resolves.toBeUndefined();
    await expect(tracing.forceFlush()).resolves.toBeUndefined();
  });
});
