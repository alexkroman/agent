// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { isTextAssetPath, normalizeSpeechText, toArgsRecord } from "../internal.ts";
import { serializeToolFailure } from "./_tool-failure-wire.ts";
import {
  errorDetail,
  errorMessage,
  isToolFailure,
  pushCapped,
  responseErrorMessage,
  toolFailure,
} from "./utils.ts";

/**
 * The empty message, as a value rather than a literal.
 *
 * Biome's `useErrorMessage` refuses an empty message literal, and it is right
 * to: the rule and the specs below make the same point from opposite ends. Naming
 * it beats spending one of the ratcheted lint suppressions on the single value
 * this suite exists to describe.
 */
const NO_MESSAGE = "";

/** A message that is all whitespace — as absent as {@link NO_MESSAGE} once trimmed. */
const WHITESPACE_MESSAGE = "   ";

describe("toArgsRecord", () => {
  test("passes a plain object through unchanged", () => {
    const args = { city: "Paris", n: 1 };
    expect(toArgsRecord(args)).toBe(args);
  });

  test("coerces non-record inputs to an empty record", () => {
    // The raw-string case is what an unrepairable invalid tool call carries.
    expect(toArgsRecord('{"broken json')).toEqual({});
    expect(toArgsRecord(undefined)).toEqual({});
    expect(toArgsRecord(null)).toEqual({});
    expect(toArgsRecord([1, 2])).toEqual({});
    expect(toArgsRecord(42)).toEqual({});
  });
});

describe("errorMessage", () => {
  test("extracts message from Error instance", () => {
    expect(errorMessage(new Error("something broke"))).toBe("something broke");
  });

  test("converts string to string", () => {
    expect(errorMessage("plain string")).toBe("plain string");
  });

  test("converts number to string", () => {
    expect(errorMessage(42)).toBe("42");
  });

  test("converts null to string", () => {
    expect(errorMessage(null)).toBe("null");
  });

  test("converts undefined to string", () => {
    expect(errorMessage(undefined)).toBe("undefined");
  });

  test("renders a validation error's ISSUES, not its JSON-dump message", () => {
    // A `ZodError`'s own message is `JSON.stringify(issues, null, 2)`, so every
    // caller that reports an error by its message printed a dozen lines of
    // `{ "origin", "code", "path" }` for one wrong field.
    const zodLike = Object.assign(new Error('[\n  {\n    "code": "too_small"\n  }\n]'), {
      name: "ZodError",
      issues: [
        { message: "Too small: expected number to be >0", path: ["maxSteps"] },
        { message: "Invalid input: expected string", path: ["name"] },
      ],
    });
    expect(errorMessage(zodLike)).toBe(
      "maxSteps: Too small: expected number to be >0; name: Invalid input: expected string",
    );
  });

  test("leaves an ordinary error carrying an unrelated `issues` field alone", () => {
    // Structural detection has to be narrow: only a list of things that each
    // carry a string `message` is a validation result.
    const err = Object.assign(new Error("upload failed"), { issues: ["nope"] });
    expect(errorMessage(err)).toBe("upload failed");
  });

  test("an empty issue list is not a validation failure", () => {
    const err = Object.assign(new Error("nothing wrong"), { issues: [] });
    expect(errorMessage(err)).toBe("nothing wrong");
  });
});

/**
 * The shapes a provider client really throws.
 *
 * The failed `fetch` and the `AggregateError` below are the genuine articles.
 * The HTTP failure is a field-for-field stand-in for the AI SDK's
 * `APICallError`, because `ai` is a dependency of `aai-runtime` and not of this
 * package — `pipeline-llm-stream.test.ts` builds the same cases with the real
 * constructor, which is what keeps this stand-in honest. Detection here is
 * structural for the same reason (see {@link errorMessage}), so the stand-in is
 * exactly what the implementation sees.
 */
describe("errorMessage over real provider-client failures", () => {
  /**
   * What `createJsonErrorResponseHandler` builds for a rejected key: the message
   * is `response.statusText`, which is empty over HTTP/2 and optional in
   * HTTP/1.1, and everything worth reading is in the other fields.
   */
  function rejectedKey(responseBody: string, statusCode = 401): Error {
    return Object.assign(new Error(NO_MESSAGE), {
      name: "AI_APICallError",
      url: "https://llm-gateway.assemblyai.com/v1/chat/completions",
      requestBodyValues: { model: "qwen3-next-80b-a3b" },
      statusCode,
      responseHeaders: { "x-request-id": "req_1" },
      responseBody,
    });
  }

  test("names the cause of a rejected API key instead of reporting nothing", () => {
    // The regression: this exact value reached the browser as
    // {"type":"error.reported","code":"llm","message":"","fatal":false}.
    const err = rejectedKey(
      JSON.stringify({ error: { message: "Invalid API key", type: "invalid_request_error" } }),
    );
    expect(err.message).toBe(NO_MESSAGE);
    expect(errorMessage(err)).toBe("Invalid API key (HTTP 401 from llm-gateway.assemblyai.com)");
  });

  test("reads the other three body spellings, and previews a body in none of them", () => {
    expect(errorMessage(rejectedKey(JSON.stringify({ error: "Unauthorized" })))).toBe(
      "Unauthorized (HTTP 401 from llm-gateway.assemblyai.com)",
    );
    expect(errorMessage(rejectedKey(JSON.stringify({ message: "no credit" }), 402))).toBe(
      "no credit (HTTP 402 from llm-gateway.assemblyai.com)",
    );
    expect(errorMessage(rejectedKey(JSON.stringify({ detail: "Not authenticated" }), 403))).toBe(
      "Not authenticated (HTTP 403 from llm-gateway.assemblyai.com)",
    );
    // A proxy's HTML page fits none of them; the preview still identifies it.
    expect(errorMessage(rejectedKey("<html><body>503 upstream</body></html>", 503))).toBe(
      "<html><body>503 upstream</body></html> (HTTP 503 from llm-gateway.assemblyai.com)",
    );
  });

  test("still reports the status when the body is empty too", () => {
    // Both halves absent is the pure form of the bug — nothing to quote at all.
    expect(errorMessage(rejectedKey(""))).toBe("HTTP 401 from llm-gateway.assemblyai.com");
  });

  test("keeps the provider's own sentence and adds the status to it", () => {
    // The path where the error schema DID match: `errorToMessage` filled the
    // message in, and the status is what says whether to retry or fix a key.
    const err = Object.assign(new Error("Rate limit exceeded"), {
      name: "AI_APICallError",
      url: "https://api.openai.com/v1/chat/completions",
      statusCode: 429,
      responseBody: JSON.stringify({ error: { message: "Rate limit exceeded" } }),
    });
    expect(errorMessage(err)).toBe("Rate limit exceeded (HTTP 429 from api.openai.com)");
  });

  test("a wrapper that states its own count still leads with it", () => {
    // `RetryError.message` is stated, so it is what a caller sees; unwrapping to
    // `lastError` is the RUNTIME's job (see `llmErrorSentence`), and this pins
    // that the attempt underneath still describes itself.
    const attempt = rejectedKey(JSON.stringify({ error: { message: "Invalid API key" } }));
    const err = Object.assign(new Error("Failed after 3 attempts. Last error: "), {
      name: "AI_RetryError",
      reason: "maxRetriesExceeded",
      errors: [attempt, attempt],
      lastError: attempt,
    });
    expect(errorMessage(err)).toBe("Failed after 3 attempts. Last error:");
    expect(errorMessage(attempt)).toBe(
      "Invalid API key (HTTP 401 from llm-gateway.assemblyai.com)",
    );
  });

  test("a failed fetch reports WHY, not Node's placeholder", async () => {
    // A real one: undici throws `TypeError("fetch failed")` and puts the reason
    // in `cause`. Port 9 (discard) is refused without leaving the machine.
    const thrown = await fetch("http://127.0.0.1:9/nope").then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as TypeError).message).toBe("fetch failed");
    const message = errorMessage(thrown);
    expect(message.startsWith("fetch failed: ")).toBe(true);
    expect(message).not.toBe("fetch failed");
  });

  test("an aggregate error reports its members rather than its empty message", () => {
    // The shape `Promise.any` and `AbortSignal.any` reject with, and what a
    // provider opener throws when every endpoint refused.
    const err = new AggregateError(
      [new Error("stt refused"), new Error("tts refused")],
      NO_MESSAGE,
    );
    expect(err.message).toBe(NO_MESSAGE);
    expect(errorMessage(err)).toBe("stt refused; tts refused");
  });

  test("never answers with an empty string, whatever it is handed", () => {
    // The property the browser banner depends on. Every entry here is a value
    // the old implementation answered "" or a bare class name for.
    const cases: unknown[] = [
      rejectedKey(""),
      new Error(NO_MESSAGE),
      new Error(WHITESPACE_MESSAGE),
      new AggregateError([], NO_MESSAGE),
      NO_MESSAGE,
      "   ",
      {},
      Object.create(null),
      Object.assign(new Error(NO_MESSAGE), { name: "AI_APICallError", url: "", statusCode: 500 }),
    ];
    // Labelled by index, not by `String(value)` — one of these is a
    // null-prototype object, which throws on stringification. That is the case
    // `errorMessage`'s own guarded `String` exists for.
    cases.forEach((value, index) => {
      expect.soft(errorMessage(value), `case ${index}`).not.toBe("");
    });
    expect(errorMessage(new Error(NO_MESSAGE))).toBe("Error (no message)");
    expect(errorMessage(NO_MESSAGE)).toBe("Unknown error");
    expect(errorMessage({})).toBe("Unknown error");
  });

  test("a self-referential cause chain terminates", () => {
    // Not defensive bookkeeping: an error re-thrown as its own cause is a
    // two-line mistake, and the walk below would not otherwise return.
    const err = new Error(NO_MESSAGE);
    (err as { cause?: unknown }).cause = err;
    expect(errorMessage(err)).toBe("Error (no message)");
  });
});

describe("errorDetail", () => {
  test("returns stack trace when available", () => {
    const err = new Error("something broke");
    const result = errorDetail(err);
    expect(result).toBe(err.stack);
    expect(result).toContain("something broke");
  });

  test("returns message when stack is undefined", () => {
    const err = new Error("no stack");
    Object.defineProperty(err, "stack", { value: undefined });
    expect(errorDetail(err)).toBe("no stack");
  });

  test("converts string to string", () => {
    expect(errorDetail("plain string")).toBe("plain string");
  });

  test("converts null to string", () => {
    expect(errorDetail(null)).toBe("null");
  });

  test("converts undefined to string", () => {
    expect(errorDetail(undefined)).toBe("undefined");
  });
});

describe("isTextAssetPath", () => {
  test.each(["index.html", "assets/app.js", "styles.css", "data.json", "icon.svg", "app.js.map"])(
    "treats %s as text",
    (p) => {
      expect(isTextAssetPath(p)).toBe(true);
    },
  );

  test.each(["logo.png", "font.woff2", "img.jpg", "clip.mp3", "module.wasm", "noext"])(
    "treats %s as binary",
    (p) => {
      expect(isTextAssetPath(p)).toBe(false);
    },
  );

  test("is case-insensitive on the extension", () => {
    expect(isTextAssetPath("INDEX.HTML")).toBe(true);
    expect(isTextAssetPath("LOGO.PNG")).toBe(false);
  });
});

describe("normalizeSpeechText", () => {
  test("folds the apostrophe LLMs actually emit", () => {
    // Model output is typeset prose: `You’re`, `I’ll`, `don’t` all carry
    // U+2019, which is a different codepoint from the `'` that pronunciation
    // lexicons are keyed on.
    expect(normalizeSpeechText("You’re verified. I’ll check, don’t worry.")).toBe(
      "You're verified. I'll check, don't worry.",
    );
  });

  test("folds the rest of the quote family", () => {
    expect(normalizeSpeechText("‘a’ “b” „c‟")).toBe('\'a\' "b" "c"');
    expect(normalizeSpeechText("5′ by 6″")).toBe("5' by 6\"");
    expect(normalizeSpeechText("Hawaiʼi")).toBe("Hawai'i");
  });

  // THE invariant. The heard cursor indexes a reply's TTS text by
  // `text.length` (pipeline-heard.ts), and that index decides what history
  // records as heard and where a resume picks up. A substitution that changed
  // length would silently shift both.
  test.each(["You’re “done”", "‘’‚‛ʼ′“”„″", "no typography here"])(
    "is length-preserving, which the heard cursor depends on: %j",
    (s) => {
      expect(normalizeSpeechText(s)).toHaveLength(s.length);
    },
  );

  // Prosody, not typography: TTS engines already render these as pauses, and
  // folding them would also break the length invariant above.
  test("leaves prosodic punctuation alone", () => {
    const s = "Wait — hold on … ready?";
    expect(normalizeSpeechText(s)).toBe(s);
  });

  test("returns the same reference when there is nothing to replace", () => {
    const s = "Found your account. Two orders.";
    expect(normalizeSpeechText(s)).toBe(s);
  });

  // The regex is module-scoped with /g, so a stale lastIndex would make every
  // other call skip the start of its input.
  test("repeated calls do not leak regex state", () => {
    const s = "It’s fine";
    expect(normalizeSpeechText(s)).toBe("It's fine");
    expect(normalizeSpeechText(s)).toBe("It's fine");
    expect(normalizeSpeechText(s)).toBe("It's fine");
  });
});

describe("isToolFailure", () => {
  test("narrows an object carrying a string error", () => {
    expect(isToolFailure({ error: "Order not found." })).toBe(true);
  });

  test("accepts a failure carrying extra fields", () => {
    // Helpers attach context alongside the message; the guard is about the
    // `error` field, not about the object being exactly that one key.
    expect(isToolFailure({ error: "not found", orderId: "#W1" })).toBe(true);
  });

  test("rejects a successful result that happens to be an object", () => {
    expect(isToolFailure({ orderId: "#W1", total: 12 })).toBe(false);
  });

  test("rejects a non-string error field", () => {
    // An `Error` instance under `error` is a thrown fault someone stored, not
    // the wire shape — narrowing it would hand callers `.error` as an object
    // where they format it as text.
    expect(isToolFailure({ error: new Error("boom") })).toBe(false);
    expect(isToolFailure({ error: 500 })).toBe(false);
    expect(isToolFailure({ error: null })).toBe(false);
  });

  test("rejects null, undefined and primitives", () => {
    expect(isToolFailure(null)).toBe(false);
    expect(isToolFailure(undefined)).toBe(false);
    expect(isToolFailure("error")).toBe(false);
    expect(isToolFailure(0)).toBe(false);
  });

  test("rejects an array", () => {
    expect(isToolFailure([{ error: "nested" }])).toBe(false);
  });

  test("narrows what toolFailure builds", () => {
    // The pair that is meant to compose. This is the assertion the NAMES now
    // promise, and it is why `toolError` was renamed: the old name read as this
    // function's constructor and behaved like the one below.
    expect(isToolFailure(toolFailure("boom"))).toBe(true);
    expect(toolFailure("boom")).toEqual({ error: "boom" });
  });

  test("does NOT narrow serializeToolFailure's string, and that is documented", () => {
    // The two spellings coexist on this module: `serializeToolFailure` is the host's
    // pre-serialized wire form, `ToolFailure` is what a tool author returns.
    // Mistaking one for the other is the trap the doc comment calls out — and
    // what the rename makes hard to fall into, since neither name now claims to
    // build the other's shape.
    expect(isToolFailure(serializeToolFailure("boom"))).toBe(false);
  });

  test("narrows the type, not just the value", () => {
    // Behind a function so the union survives — a `const` initialized with one
    // member narrows to it, and the false branch would be `never`.
    const lookup = (found: boolean): { id: string } | { error: string } =>
      found ? { id: "#W1" } : { error: "nope" };
    // Reads `.error` / `.id` with no cast — that this compiles IS the assertion.
    expect(isToolFailure(lookup(false)) ? "failed" : "ok").toBe("failed");
    const hit = lookup(true);
    expect(isToolFailure(hit) ? hit.error : hit.id).toBe("#W1");
  });
});

describe("pushCapped", () => {
  test("appends below the cap", () => {
    expect(pushCapped(["a", "b"], "c", 5)).toEqual(["a", "b", "c"]);
  });

  test("drops the oldest entry at the cap", () => {
    expect(pushCapped(["a", "b", "c"], "d", 3)).toEqual(["b", "c", "d"]);
  });

  test("mutates in place — the caller's reference reflects the cap", () => {
    // The list is usually a property of the state object (`incident.timeline`),
    // so in-place is what saves the caller a reassignment they can forget.
    const state = { timeline: ["a", "b", "c"] };
    const returned = pushCapped(state.timeline, "d", 3);
    expect(state.timeline).toEqual(["b", "c", "d"]);
    expect(returned).toBe(state.timeline);
  });

  test("trims a list that was already over the cap", () => {
    // Reachable when a cap is lowered, or when state was restored from a save
    // written under a larger one.
    expect(pushCapped(["a", "b", "c", "d", "e"], "f", 3)).toEqual(["d", "e", "f"]);
  });

  test("a cap of 1 keeps only the newest", () => {
    expect(pushCapped(["a", "b"], "c", 1)).toEqual(["c"]);
  });

  test("a cap of 0 or below keeps nothing, including the new entry", () => {
    expect(pushCapped(["a"], "b", 0)).toEqual([]);
    expect(pushCapped(["a"], "b", -3)).toEqual([]);
  });

  test("repeated appends hold the cap", () => {
    const log: number[] = [];
    for (let i = 0; i < 100; i += 1) pushCapped(log, i, 4);
    expect(log).toEqual([96, 97, 98, 99]);
  });
});

describe("responseErrorMessage", () => {
  test("returns the agent's own sentence, unwrapped and unprefixed", async () => {
    const res = new Response(JSON.stringify({ error: "No workflow named digest" }), {
      status: 404,
    });
    expect(await responseErrorMessage(res, "Workflow API")).toBe("No workflow named digest");
  });

  test("a body that is not the { error } shape degrades to the status and a preview", async () => {
    // What a proxy or a CDN in front of the agent answers with.
    const res = new Response("<html>502 Bad Gateway</html>", { status: 502 });
    expect(await responseErrorMessage(res)).toBe("502: <html>502 Bad Gateway</html>");
  });

  test("VALID JSON that is not { error } is quoted too, not dropped", async () => {
    // The bug in the copy this replaced: the parse succeeded, so the fallback
    // that quotes the body never ran and a gateway's own envelope was lost.
    const res = new Response(JSON.stringify({ message: "upstream refused" }), { status: 503 });
    expect(await responseErrorMessage(res)).toBe('503: {"message":"upstream refused"}');
  });

  test("an empty body is the bare status", async () => {
    expect(await responseErrorMessage(new Response("", { status: 401 }))).toBe("401");
  });

  test("`label` names the surface, but ONLY when we fall back to the status", async () => {
    const bare = new Response("", { status: 500 });
    expect(await responseErrorMessage(bare, "Workflow API")).toBe("Workflow API 500");
    const spoken = new Response(JSON.stringify({ error: "sandbox still booting" }), {
      status: 503,
    });
    // No prefix here — our words must not sit in front of the agent's.
    expect(await responseErrorMessage(spoken, "Workflow API")).toBe("sandbox still booting");
  });

  test("an EMPTY error string is not a diagnostic, so the status wins", async () => {
    const res = new Response(JSON.stringify({ error: "" }), { status: 500 });
    expect(await responseErrorMessage(res)).toBe('500: {"error":""}');
  });

  test("a non-string `error` falls through rather than rendering an object", async () => {
    const res = new Response(JSON.stringify({ error: { code: 7 } }), { status: 400 });
    expect(await responseErrorMessage(res)).toBe('400: {"error":{"code":7}}');
  });

  test("the preview is capped, so a whole HTML document cannot reach a log line", async () => {
    const res = new Response("x".repeat(5000), { status: 500 });
    const message = await responseErrorMessage(res);
    // Capped AND marked: a cut body and a short one otherwise read identically
    // to whoever is holding the log line, and a JSON envelope cut mid-token
    // looks malformed rather than long.
    expect(message).toBe(`500: ${"x".repeat(200)}\u2026`);
  });

  test("a body exactly at the cap is quoted whole, with no marker", async () => {
    const res = new Response("y".repeat(200), { status: 500 });
    expect(await responseErrorMessage(res)).toBe(`500: ${"y".repeat(200)}`);
  });

  test("a body that cannot be read at all degrades instead of throwing", async () => {
    // This runs on a path that is already reporting a failure; a second one
    // there has nowhere to go. A REAL `Response` over an errored stream rather
    // than a cast object — a connection dropping mid-body is what produces this,
    // and a stub would only prove the branch, not that `text()` really rejects.
    const res = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("connection reset mid-body"));
        },
      }),
      { status: 500 },
    );
    await expect(responseErrorMessage(res)).resolves.toBe("500");
  });
});
