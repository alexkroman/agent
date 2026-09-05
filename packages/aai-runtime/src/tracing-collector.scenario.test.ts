// Copyright 2026 the AAI authors. MIT license.
/**
 * The OTLP wire path, against a REAL collector.
 *
 * ## What this closes
 *
 * `tracing.test.ts` and `_tracing-otel.test.ts` drive an `InMemorySpanExporter`,
 * which proves what a span CONTAINS and nothing about whether one ever leaves
 * the process. Everything past that boundary — protobuf encoding, the
 * `/v1/traces` suffix rule, real HTTP, the batch processor's flush — belonged
 * to the library, and this repo's own tracing guide said so under a heading
 * reading "Not verified": *no live collector has ever been exercised.* A
 * feature nobody has ever seen work is not a feature, so that sentence was the
 * one thing standing between this and being usable.
 *
 * It is SCENARIO tier because it binds a port and makes a real request, which
 * is the unit tier's boundary (AGENTS.md, "Test tiers").
 *
 * ## The redaction assertion is the point of doing it here
 *
 * `_tracing-otel.test.ts` already asserts no conversation content reaches a
 * span. This asserts it of the BYTES ON THE WIRE, which is the claim an
 * operator actually cares about and the only place a serialization bug could
 * add content back. The four secrets are distinctive strings that exist
 * nowhere else, searched for in the raw protobuf body.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { trace } from "@opentelemetry/api";
import { generateText, stepCountIs, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { startTracing } from "./tracing.ts";

/** Strings that exist nowhere but the conversation this test drives. */
const PROMPT = "MAGICPROMPT-my-card-is-4111111111111111";
const REPLY = "MAGICREPLY-your-balance-is-1234";
const TOOL_ARG = "MAGICARG-seattle";
const TOOL_RESULT = "MAGICRESULT-72-degrees";
const SECRETS = [PROMPT, REPLY, TOOL_ARG, TOOL_RESULT];

type Delivery = { path: string; contentType: string | undefined; body: Buffer };

/** An OTLP/HTTP receiver that answers as the spec says and keeps the bytes. */
async function collector(): Promise<{
  url: string;
  deliveries: Delivery[];
  close: () => Promise<void>;
}> {
  const deliveries: Delivery[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      deliveries.push({
        path: req.url ?? "",
        contentType: req.headers["content-type"],
        body: Buffer.concat(chunks),
      });
      // An empty `ExportTraceServiceResponse` is a success — a non-2xx would
      // put the exporter into its retry loop and this test into its timeout.
      res.writeHead(200, { "Content-Type": "application/x-protobuf" });
      res.end(Buffer.alloc(0));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    deliveries,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A two-step generation: one tool call, then a text answer. */
async function runConversation(): Promise<void> {
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

/** `registerTelemetry` has no unregister, and the provider is global. */
afterEach(() => {
  (globalThis as { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown }).AI_SDK_TELEMETRY_INTEGRATIONS =
    undefined;
  trace.disable();
});

describe("the OTLP wire path", () => {
  test("delivers spans to a real collector, as protobuf, at /v1/traces", async () => {
    const sink = await collector();
    try {
      // `process.env`, not the argument: `startTracing`'s env parameter is
      // only the PREDICATE — the exporter resolves the URL, headers and
      // timeout itself, from the real environment, which is the whole reason
      // this module refuses to re-parse them. Passing the argument alone
      // silently exported to OTel's DEFAULT endpoint (localhost:4318) and
      // looked like it worked, which is exactly the class of thing only a
      // live collector catches.
      vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", sink.url);
      vi.stubEnv("OTEL_SERVICE_NAME", "wire-path-probe");
      const tracing = await startTracing();
      expect(tracing).toBeDefined();
      await runConversation();
      await tracing?.forceFlush();
      await tracing?.shutdown();

      expect(sink.deliveries).toHaveLength(1);
      const [delivery] = sink.deliveries;
      // The suffix rule this module deliberately leaves to the exporter:
      // `OTEL_EXPORTER_OTLP_ENDPOINT` gets `/v1/traces` appended.
      expect(delivery?.path).toBe("/v1/traces");
      expect(delivery?.contentType).toBe("application/x-protobuf");
      expect(delivery?.body.length).toBeGreaterThan(0);

      // Resource and attribute names survive as UTF-8 inside the protobuf, so
      // arrival can be asserted without decoding it.
      const wire = delivery?.body.toString("utf8") ?? "";
      expect(wire).toContain("wire-path-probe");
      expect(wire).toContain("ai.generate");
      expect(wire).toContain("gen_ai.usage.input_tokens");
    } finally {
      await sink.close();
    }
  }, 30_000);

  test("sends no conversation content over the wire", async () => {
    const sink = await collector();
    try {
      vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", sink.url);
      const tracing = await startTracing();
      await runConversation();
      await tracing?.forceFlush();
      await tracing?.shutdown();

      const wire = Buffer.concat(sink.deliveries.map((d) => d.body)).toString("utf8");
      expect(wire.length).toBeGreaterThan(0);
      for (const secret of SECRETS) expect(wire).not.toContain(secret);
    } finally {
      await sink.close();
    }
  }, 30_000);
});
