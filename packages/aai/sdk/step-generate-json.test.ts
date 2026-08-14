// Copyright 2026 the AAI authors. MIT license.
import { beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { StepGenerateError } from "./step-generate.ts";
import { stepGenerateJson, stripJsonFence } from "./step-generate-json.ts";
import { stubGateway } from "./testing-gateway.ts";

const Reply = z.object({ headline: z.string(), points: z.array(z.string()) });

/** The SDK's own fake gateway, installed — see `sdk/testing-gateway.ts`. */
function install(replies: string | readonly string[], status?: number) {
  const gateway = stubGateway(replies, status === undefined ? {} : { status });
  vi.stubGlobal("fetch", gateway.fetch);
  return gateway;
}

beforeEach(() => {
  // `stepEnv` falls back to the process env when no host has published one,
  // which is exactly the case a spec is. `unstubEnvs` clears it per test.
  vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
});

describe("stepGenerateJson", () => {
  test("returns the reply validated, typed as the schema's output", async () => {
    install('{"headline":"Otters use tools","points":["a","b"]}');

    expect(await stepGenerateJson("Summarize.", { schema: Reply })).toEqual({
      headline: "Otters use tools",
      points: ["a", "b"],
    });
  });

  test("unwraps a ```json fence, which is what models add anyway", async () => {
    // Refusing one would cost a whole retry for a reply that was otherwise
    // correct — which is the entire reason this is not just `JSON.parse`.
    install('```json\n{"headline":"H","points":[]}\n```');

    expect((await stepGenerateJson("Summarize.", { schema: Reply })).headline).toBe("H");
  });

  test("passes the system instruction and prompt straight through", async () => {
    const gateway = install('{"headline":"H","points":[]}');

    await stepGenerateJson("The article.", { schema: Reply, system: "Reply with JSON." });

    expect(gateway.calls[0]).toMatchObject({
      prompt: "The article.",
      system: "Reply with JSON.",
    });
  });

  test("does not leak `schema` into the request body", async () => {
    // It is this module's option, not the gateway's — and a zod schema is not
    // JSON-serializable in any useful way, so a leak would be a silent
    // `{}` riding on every request.
    const gateway = install('{"headline":"H","points":[]}');

    await stepGenerateJson("x", { schema: Reply, temperature: 0.2 });

    expect(gateway.calls[0]?.body).not.toHaveProperty("schema");
    expect(gateway.calls[0]?.body).toMatchObject({ temperature: 0.2 });
  });

  test("throws PLAINLY on prose, so the DevKit retries it", async () => {
    // The distinction that is the whole retry policy: a model that ignored the
    // format may obey next time, where a 401 will not. Plain means NOT a
    // `FatalError`, which is the thing the DevKit stops on.
    install("Here is a summary of the article.");

    const err = await stepGenerateJson("x", { schema: Reply }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("Error");
    expect((err as Error).message).toMatch(/Expected JSON from the model/);
  });

  test("throws PLAINLY on JSON that is a bare scalar or null", async () => {
    install("42");
    await expect(stepGenerateJson("x", { schema: Reply })).rejects.toThrow(/Expected JSON/);
    install("null");
    await expect(stepGenerateJson("x", { schema: Reply })).rejects.toThrow(/Expected JSON/);
  });

  test("lets the SCHEMA reject an array, which reads better than the guard would", async () => {
    // An array is `typeof "object"`, so it reaches validation rather than the
    // shape guard — and the message is the better one for it: the guard can
    // only say "not an object", where the schema says which shape was wanted.
    install("[1, 2, 3]");
    await expect(stepGenerateJson("x", { schema: Reply })).rejects.toThrow(
      /did not match the shape: .*expected object, received array/,
    );
  });

  test("names the field a wrong-shaped reply missed", async () => {
    // What taking a schema buys over a hand-written guard: the failure says
    // WHICH field, so a prompt that drifted is diagnosable from the log line.
    install('{"headline":"H"}');

    await expect(stepGenerateJson("x", { schema: Reply })).rejects.toThrow(
      /did not match the shape: points/,
    );
  });

  test("caps how much of an unusable reply it quotes back", async () => {
    install("x".repeat(5000));

    const err = await stepGenerateJson("x", { schema: Reply }).catch((e: unknown) => e);
    expect((err as Error).message.length).toBeLessThan(300);
  });

  test("lets a coercing schema keep a reply a strict one would reject", async () => {
    // Supported on purpose: a model that put one number in an array of strings
    // should cost that element, not the whole pass.
    const Lenient = z.object({
      angles: z
        .array(z.unknown())
        .transform((values) => values.filter((v): v is string => typeof v === "string")),
    });
    install('{"angles":["one",2,"three"]}');

    expect(await stepGenerateJson("x", { schema: Lenient })).toEqual({
      angles: ["one", "three"],
    });
  });

  test("still reports a gateway failure as a StepGenerateError, for classifying", async () => {
    // The two failure kinds stay distinguishable: this one carries the
    // retryable verdict `toStepError` reads, and a shape failure does not.
    install("", 401);

    const err = await stepGenerateJson("x", { schema: Reply }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepGenerateError);
    expect((err as StepGenerateError).retryable).toBe(false);
  });
});

describe("stripJsonFence", () => {
  test("unwraps a fence, with or without the language tag", () => {
    expect(stripJsonFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripJsonFence('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  test("leaves unfenced JSON alone, trimmed", () => {
    expect(stripJsonFence('  {"a":1}  ')).toBe('{"a":1}');
  });

  test("leaves a fence that is not the whole reply alone", () => {
    // Only a reply that IS a fenced block is unwrapped; prose around one is a
    // reply that failed the format, and hiding that would hide the retry.
    const reply = 'Here you go:\n```json\n{"a":1}\n```';
    expect(stripJsonFence(reply)).toBe(reply);
  });
});
