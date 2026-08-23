// Copyright 2026 the AAI authors. MIT license.
/**
 * Unit tests for the OpenAI-compatible SSE tool-call repair wrapper.
 *
 * The regression these guard: the AssemblyAI LLM Gateway streams Claude
 * models with `tool_calls` deltas that omit `id` and `type`, which makes
 * `@ai-sdk/openai`'s streaming tracker throw
 * `InvalidResponseDataError: Expected 'id' to be a string`. See the module
 * doc comment in `_openai-stream-repair.ts`.
 */

import { ASSEMBLYAI_LLM_KIND } from "@alexkroman1/aai/host-internal";
import { streamText } from "ai";
import { describe, expect, it, vi } from "vitest";
import { repairOpenAiStream } from "./_openai-stream-repair.ts";
import { resolveLlm } from "./resolve.ts";

/** Build an SSE response body from already-serialized `data:` payloads. */
function sse(...payloads: string[]): string {
  return `${payloads.map((p) => `data: ${p}\n\n`).join("")}data: [DONE]\n\n`;
}

function chunk(delta: unknown, finishReason: string | null = null): string {
  return JSON.stringify({
    id: "chatcmpl-1",
    created: 1,
    model: "claude-sonnet-4-6",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

/**
 * A `fetch` that resolves every call to `respond()` — the file's ONE narrowing
 * seam for fake fetches.
 *
 * `vi.fn(async () => new Response(…))` infers a nullary async function, which
 * is not assignable to `typeof globalThis.fetch` (RequestInfo/URL + RequestInit,
 * plus overloads), so each fake previously carried its own double cast. Route
 * new ones through here instead of adding a cast at the call site; the returned
 * value is still the spy, so `toHaveBeenCalled` assertions work unchanged.
 */
function respondingFetch(respond: () => Promise<Response>): typeof globalThis.fetch {
  return vi.fn(respond) as unknown as typeof globalThis.fetch;
}

/** A fetch that replays `body` as an SSE response, in the given slices. */
function sseFetch(body: string, slices = 1): typeof globalThis.fetch {
  return respondingFetch(async () => {
    const encoder = new TextEncoder();
    const size = Math.ceil(body.length / slices);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < body.length; at += size) {
          controller.enqueue(encoder.encode(body.slice(at, at + size)));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });
}

/** Read a repaired response body back into its `data:` payload strings. */
async function readPayloads(response: Response): Promise<string[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6));
}

/** Deterministic id source so assertions can name exact ids. */
function seqIds(): () => string {
  let n = 0;
  return () => `id_${++n}`;
}

async function repaired(body: string, slices = 1): Promise<string[]> {
  const wrapped = repairOpenAiStream(sseFetch(body, slices), { generateId: seqIds() });
  return readPayloads(await wrapped("https://example.test/v1/chat/completions"));
}

describe("repairOpenAiStream", () => {
  it("rewrites a null choices array to empty on the gateway's final usage chunk", async () => {
    // Claude models on the gateway end the stream with a usage-only chunk
    // carrying `"choices": null`. The AI SDK's chunk schema requires an array,
    // so the whole turn dies with "Type validation failed" *after* the text
    // has already streamed.
    const usageOnly = JSON.stringify({
      id: "msg_bdrk_01",
      object: "chat.completion.chunk",
      created: 1,
      model: "claude-haiku-4-5-20251001",
      choices: null,
      usage: { prompt_tokens: 4566, completion_tokens: 31, total_tokens: 4597 },
    });
    const payloads = await repaired(sse(usageOnly));
    const parsed = JSON.parse(payloads[0] ?? "{}") as { choices: unknown; usage: unknown };
    expect(parsed.choices).toEqual([]);
    // The usage numbers are why the chunk exists — they must survive.
    expect(parsed.usage).toMatchObject({ total_tokens: 4597 });
  });

  it.each([
    ['{"usage":{"total_tokens":1},"choices": null}', "one space"],
    ['{"usage":{"total_tokens":1},"choices" : null}', "space either side"],
    ['{"usage":{"total_tokens":1},"choices":\tnull}', "a tab"],
  ])("repairs a null choices spelled with %s (%s)", async (usageOnly) => {
    // The compact-only probe was justified by "JSON.stringify never puts
    // whitespace after a colon" — a claim about OUR serializer, when these are
    // the GATEWAY's bytes. Any encoder that pretty-prints, or a proxy that
    // re-serializes, spells the same defect with a space, and a miss is not a
    // degradation: it is the exact "Type validation failed" this module exists
    // to prevent, fired after the reply has already streamed.
    const payloads = await repaired(sse(usageOnly));
    expect((JSON.parse(payloads[0] ?? "{}") as { choices: unknown }).choices).toEqual([]);
  });

  it("leaves a missing choices key alone", async () => {
    // Only an explicit null is repaired; absent stays absent.
    const payloads = await repaired(sse(JSON.stringify({ id: "x", usage: { total_tokens: 1 } })));
    expect(JSON.parse(payloads[0] ?? "{}")).not.toHaveProperty("choices");
  });

  it("injects a synthetic id and type into an opening tool_call delta", async () => {
    const payloads = await repaired(
      sse(chunk({ tool_calls: [{ index: 0, function: { name: "list_files", arguments: "" } }] })),
    );
    const call = JSON.parse(payloads[0] as string).choices[0].delta.tool_calls[0];
    expect(call).toMatchObject({ index: 0, id: "id_1", type: "function" });
  });

  it("reuses one id across continuation deltas for the same index", async () => {
    const payloads = await repaired(
      sse(
        chunk({ tool_calls: [{ index: 0, function: { name: "write_file", arguments: "" } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }),
      ),
    );
    const ids = payloads
      .filter((p) => p !== "[DONE]")
      .map((p) => JSON.parse(p).choices[0].delta.tool_calls[0].id);
    expect(ids).toEqual(["id_1", "id_1", "id_1"]);
  });

  it("gives parallel tool calls distinct ids", async () => {
    const payloads = await repaired(
      sse(
        chunk({
          tool_calls: [
            { index: 0, function: { name: "read_file", arguments: "" } },
            { index: 1, function: { name: "list_files", arguments: "" } },
          ],
        }),
      ),
    );
    const calls = JSON.parse(payloads[0] as string).choices[0].delta.tool_calls;
    expect(calls.map((c: { id: string }) => c.id)).toEqual(["id_1", "id_2"]);
  });

  it("preserves an id the upstream actually sent", async () => {
    const payloads = await repaired(
      sse(
        chunk({
          tool_calls: [
            { index: 0, id: "call_real", type: "function", function: { name: "x", arguments: "" } },
          ],
        }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: "{}" } }] }),
      ),
    );
    const ids = payloads
      .filter((p) => p !== "[DONE]")
      .map((p) => JSON.parse(p).choices[0].delta.tool_calls[0].id);
    expect(ids).toEqual(["call_real", "call_real"]);
  });

  it("passes lines that cannot need repair through without reserializing", async () => {
    // Non-canonical spacing and key order survive verbatim — JSON.stringify
    // would normalize both, so byte-equality proves the fast path skipped
    // the parse/stringify round trip entirely.
    const body = `data: {"choices" :[ {"delta": {"content":"hi"} } ],  "id":"x"}\n\ndata: [DONE]\n\n`;
    const wrapped = repairOpenAiStream(sseFetch(body), { generateId: seqIds() });
    const out = await (await wrapped("https://example.test/v1/chat/completions")).text();
    expect(out).toBe(body);
  });

  it("emits every line of a many-line network chunk in order", async () => {
    // One network chunk carrying several complete SSE events exercises the
    // moving-start line scan (vs. the old slice-per-line loop).
    const payloads = await repaired(
      sse(
        chunk({ content: "a" }),
        chunk({ tool_calls: [{ index: 0, function: { name: "f", arguments: "" } }] }),
        chunk({ content: "b" }),
      ),
      1,
    );
    expect(payloads).toHaveLength(4); // 3 chunks + [DONE]
    expect(JSON.parse(payloads[0] as string).choices[0].delta.content).toBe("a");
    expect(JSON.parse(payloads[1] as string).choices[0].delta.tool_calls[0].id).toBe("id_1");
    expect(JSON.parse(payloads[2] as string).choices[0].delta.content).toBe("b");
  });

  it("leaves text-only deltas and the [DONE] sentinel untouched", async () => {
    const body = sse(chunk({ role: "assistant", content: "hi" }), chunk({}, "stop"));
    const wrapped = repairOpenAiStream(sseFetch(body), { generateId: seqIds() });
    const out = await (await wrapped("https://example.test/v1/chat/completions")).text();
    expect(out).toBe(body);
  });

  it("passes non-JSON data lines through unchanged", async () => {
    const body = "data: not json\n\ndata: [DONE]\n\n";
    const wrapped = repairOpenAiStream(sseFetch(body), { generateId: seqIds() });
    const out = await (await wrapped("https://example.test/v1/chat/completions")).text();
    expect(out).toBe(body);
  });

  it("repairs a delta split across network chunk boundaries", async () => {
    const payloads = await repaired(
      sse(chunk({ tool_calls: [{ index: 0, function: { name: "list_files", arguments: "" } }] })),
      37, // force mid-JSON splits
    );
    const call = JSON.parse(payloads[0] as string).choices[0].delta.tool_calls[0];
    expect(call).toMatchObject({ id: "id_1", type: "function" });
  });

  it("does not touch non-SSE responses", async () => {
    const json = JSON.stringify({ choices: [{ message: { content: "hi" } }] });
    const base = respondingFetch(
      async () =>
        new Response(json, { status: 200, headers: { "content-type": "application/json" } }),
    );
    const wrapped = repairOpenAiStream(base, { generateId: seqIds() });
    const response = await wrapped("https://example.test/v1/chat/completions");
    expect(await response.text()).toBe(json);
  });

  it("preserves status and headers of the upstream response", async () => {
    const base = respondingFetch(
      async () => new Response("nope", { status: 429, headers: { "retry-after": "3" } }),
    );
    const wrapped = repairOpenAiStream(base);
    const response = await wrapped("https://example.test/v1/chat/completions");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3");
  });
});

describe("assemblyai LLM gateway wiring", () => {
  const toolCallStream = sse(
    chunk({ role: "assistant", content: "" }),
    chunk({ tool_calls: [{ index: 0, function: { name: "list_files", arguments: "" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: "{}" } }] }),
    chunk({}, "tool_calls"),
  );

  /** Drain a `streamText` result, returning the tool calls it produced. */
  async function collectToolCalls(): Promise<{ toolName: string; toolCallId: string }[]> {
    const model = resolveLlm(
      { kind: ASSEMBLYAI_LLM_KIND, options: { model: "claude-sonnet-4-6" } },
      { ASSEMBLYAI_API_KEY: "test-key" },
    );
    const result = streamText({ model, prompt: "list the files" });
    const calls: { toolName: string; toolCallId: string }[] = [];
    for await (const part of result.fullStream) {
      if (part.type === "tool-call") calls.push(part);
      if (part.type === "error") throw part.error;
    }
    return calls;
  }

  it("streams an id-less gateway tool call through resolveLlm without throwing", async () => {
    // `unstubAllGlobals` in a `finally`, not left to the end of the file:
    // `restoreMocks`/`unstubEnvs` do not cover globals, so a stub left in
    // place leaks the fake `fetch` into every later test — harmless here only
    // because this happens to be the second-to-last one. `resolve.test.ts`
    // carries the same try/finally.
    vi.stubGlobal("fetch", sseFetch(toolCallStream));
    try {
      const calls = await collectToolCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.toolName).toBe("list_files");
      expect(calls[0]?.toolCallId).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("documents the raw SDK failure the wrapper exists to fix", async () => {
    // Same stream, but straight through @ai-sdk/openai with no repair.
    const { createOpenAI } = await import("@ai-sdk/openai");
    const model = createOpenAI({
      apiKey: "test-key",
      baseURL: "https://example.test/v1",
      fetch: sseFetch(toolCallStream),
    }).chat("claude-sonnet-4-6");
    const result = streamText({ model, prompt: "list the files" });
    await expect(
      (async () => {
        for await (const part of result.fullStream) {
          if (part.type === "error") throw part.error;
        }
      })(),
    ).rejects.toThrow(/Expected 'id' to be a string/);
  });
});
