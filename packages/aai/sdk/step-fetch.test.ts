// Copyright 2026 the AAI authors. MIT license.
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  multipartBody,
  publishStepFetch,
  type StepFetchInit,
  StepTransportError,
  stepFetch,
} from "./step-fetch.ts";

afterEach(() => publishStepFetch(undefined));

describe("stepFetch", () => {
  test("uses the published fetch when a host has installed one", async () => {
    const published = vi.fn(async () => new Response("ok"));
    publishStepFetch(published);
    const global = vi.fn();
    vi.stubGlobal("fetch", global);

    await expect(stepFetch("https://example.test/x").then((r) => r.text())).resolves.toBe("ok");
    expect(published).toHaveBeenCalledOnce();
    // The whole point of the slot: a host's HTTP/1.1 fetch WINS over the global,
    // which speaks HTTP/2 wherever the far side offers it.
    expect(global).not.toHaveBeenCalled();
  });

  test("falls back to the global fetch with no host, so an exported step is testable", async () => {
    const global = vi.fn(async () => new Response("from global"));
    vi.stubGlobal("fetch", global);
    await expect(stepFetch("https://example.test/x").then((r) => r.text())).resolves.toBe(
      "from global",
    );
  });

  test("passes method, headers, body and signal through unchanged", async () => {
    const seen: StepFetchInit[] = [];
    publishStepFetch(async (_url, init = {}) => {
      seen.push(init);
      return new Response("");
    });
    const controller = new AbortController();
    const body = new Uint8Array([1, 2, 3]);
    await stepFetch("https://example.test/x", {
      method: "POST",
      headers: { Authorization: "k" },
      body,
      signal: controller.signal,
    });
    expect(seen[0]).toEqual({
      method: "POST",
      headers: { Authorization: "k" },
      body,
      signal: controller.signal,
    });
  });

  test("wraps a connection failure as StepTransportError, naming the whole cause chain", async () => {
    // The shape undici really produces: a bare `TypeError` whose reason is a hop
    // down. Reporting only the top is what made a fan-out's failure unreadable.
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    publishStepFetch(() => Promise.reject(new TypeError("fetch failed", { cause: reset })));

    const failure = await stepFetch("https://sync.example.test/transcribe?token=secret").catch(
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(StepTransportError);
    const error = failure as StepTransportError;
    expect(error.message).toContain("sync.example.test did not answer");
    expect(error.message).toContain("TypeError: fetch failed");
    expect(error.message).toContain("Error: read ECONNRESET [ECONNRESET]");
    expect(error.codes).toEqual(["ECONNRESET"]);
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  test("names the HOST only, so a token in the query string stays out of the run's error", async () => {
    publishStepFetch(() => Promise.reject(new Error("nope")));
    const failure = await stepFetch("https://api.example.test/v1?token=super-secret").catch(
      (err: unknown) => err,
    );
    expect(String(failure)).not.toContain("super-secret");
  });

  test("reports the HTTP/2 stream reset that started all this, code and all", async () => {
    const h2 = Object.assign(new Error("Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM"), {
      code: "ERR_HTTP2_STREAM_ERROR",
    });
    publishStepFetch(() => Promise.reject(new TypeError("fetch failed", { cause: h2 })));
    const failure = (await stepFetch("https://x.example.test/").catch(
      (err: unknown) => err,
    )) as StepTransportError;
    expect(failure.message).toContain("NGHTTP2_ENHANCE_YOUR_CALM");
    expect(failure.codes).toContain("ERR_HTTP2_STREAM_ERROR");
  });

  test("survives an unparsable URL rather than replacing the failure it is reporting", async () => {
    publishStepFetch(() => Promise.reject(new Error("nope")));
    const failure = (await stepFetch("not-a-url").catch(
      (err: unknown) => err,
    )) as StepTransportError;
    expect(failure).toBeInstanceOf(StepTransportError);
    expect(failure.message).toContain("not-a-url did not answer");
  });

  test("a cause CYCLE terminates instead of hanging the error's own construction", async () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    Object.defineProperty(a, "cause", { value: b });
    publishStepFetch(() => Promise.reject(b));
    const failure = (await stepFetch("https://x.example.test/").catch(
      (err: unknown) => err,
    )) as StepTransportError;
    expect(failure.message).toContain("Error: b");
  });

  test("a RESPONSE with a bad status is returned, not thrown — only the caller knows", async () => {
    publishStepFetch(async () => new Response("nope", { status: 503 }));
    const response = await stepFetch("https://x.example.test/");
    expect(response.status).toBe(503);
  });

  test("publishing undefined unpublishes", async () => {
    publishStepFetch(async () => new Response("published"));
    publishStepFetch(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("global")),
    );
    await expect(stepFetch("https://x.example.test/").then((r) => r.text())).resolves.toBe(
      "global",
    );
  });
});

describe("multipartBody", () => {
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

  test("encodes one file part with its filename and type", () => {
    const part = multipartBody({
      name: "audio",
      filename: "clip.wav",
      type: "audio/wav",
      bytes: new TextEncoder().encode("RIFFdata"),
    });
    const text = decode(part.body);
    const boundary = /boundary=(.+)$/.exec(part.headers["Content-Type"])?.[1];
    expect(boundary).toBeTruthy();
    expect(text).toContain(`--${boundary}\r\n`);
    expect(text).toContain('Content-Disposition: form-data; name="audio"; filename="clip.wav"');
    expect(text).toContain("Content-Type: audio/wav\r\n\r\n");
    expect(text).toContain("RIFFdata");
    // The closing delimiter, which a server needs to consider the body complete.
    expect(text.endsWith(`--${boundary}--\r\n`)).toBe(true);
  });

  test("a part with no filename is an ordinary field, with no Content-Type of its own", () => {
    const text = decode(
      multipartBody({ name: "model", bytes: new TextEncoder().encode("universal") }).body,
    );
    expect(text).toContain('Content-Disposition: form-data; name="model"\r\n\r\n');
    expect(text).not.toContain("Content-Type: application/octet-stream");
    expect(text).toContain("universal");
  });

  test("a file part with no declared type falls back to octet-stream", () => {
    const text = decode(
      multipartBody({ name: "f", filename: "x.bin", bytes: new Uint8Array([1]) }).body,
    );
    expect(text).toContain("Content-Type: application/octet-stream");
  });

  test("several parts share one boundary and one closing delimiter", () => {
    const part = multipartBody(
      { name: "a", bytes: new TextEncoder().encode("1") },
      { name: "b", filename: "b.txt", type: "text/plain", bytes: new TextEncoder().encode("2") },
    );
    const boundary = /boundary=(.+)$/.exec(part.headers["Content-Type"])?.[1] ?? "";
    const text = decode(part.body);
    expect(text.split(`--${boundary}`).length - 1).toBe(3);
    expect(text).toContain('name="a"');
    expect(text).toContain('name="b"; filename="b.txt"');
  });

  test("binary bytes survive verbatim — the whole reason this is not a string builder", () => {
    // 0x80-0xff is where a naive string round trip loses: decoded as UTF-8 and
    // re-encoded, every invalid byte becomes U+FFFD, and an audio payload is
    // mostly invalid UTF-8. Located by scanning rather than by offset arithmetic,
    // so the test does not encode the header's exact length.
    const bytes = new Uint8Array([0x00, 0x80, 0xff, 0xfe, 0x7f]);
    const { body } = multipartBody({ name: "f", filename: "x.bin", bytes });
    expect([...body].join(",")).toContain([...bytes].join(","));
    // And the round trip really would have lost them, so the assertion above is
    // testing something.
    const roundTripped = new TextEncoder().encode(new TextDecoder().decode(bytes));
    expect([...roundTripped].join(",")).not.toBe([...bytes].join(","));
  });

  test("the boundary differs per call, so two concurrent bodies cannot collide", () => {
    const one = multipartBody({ name: "a", bytes: new Uint8Array(0) });
    const two = multipartBody({ name: "a", bytes: new Uint8Array(0) });
    expect(one.headers["Content-Type"]).not.toBe(two.headers["Content-Type"]);
  });

  test("the body's length is the sum of its parts, so Content-Length cannot be short", () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x00]);
    const { body, headers } = multipartBody({ name: "f", filename: "x", bytes });
    const boundary = /boundary=(.+)$/.exec(headers["Content-Type"])?.[1] ?? "";
    const head =
      `--${boundary}\r\nContent-Disposition: form-data; name="f"; filename="x"\r\n` +
      "Content-Type: application/octet-stream\r\n\r\n";
    const tail = `\r\n--${boundary}--\r\n`;
    expect(body.byteLength).toBe(head.length + bytes.byteLength + tail.length);
  });
});
