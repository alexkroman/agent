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

/** First offset at which `needle` occurs in `haystack`, or -1. */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((byte, j) => haystack[i + j] === byte)) return i;
  }
  return -1;
}

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

  test("escapes a filename that would otherwise close the header and add its own", () => {
    // An upload's `name` is "the filename the uploader gave", so this string
    // reaches a step from a browser form. Unescaped it ended the quoted value
    // and appended headers of the sender's choosing to a request carrying the
    // agent's own API key.
    const text = decode(
      multipartBody({
        name: "audio",
        filename: 'evil"\r\nX-Injected: yes\r\n\r\nforged',
        type: "audio/wav",
        bytes: new Uint8Array([65]),
      }).body,
    );
    // Present as DATA inside the quoted value, never as a header line of its own.
    expect(text).not.toContain("\r\nX-Injected");
    expect(text).toContain('filename="evil%22%0D%0AX-Injected: yes%0D%0A%0D%0Aforged"');
    // One part, one header block: the CRLFs are gone, so the body still has
    // exactly the two blank-line boundaries it should.
    expect(text.split("\r\n\r\n")).toHaveLength(2);
  });

  test("escapes a field NAME the same way", () => {
    const text = decode(
      multipartBody({ name: 'a"; filename="x.sh', bytes: new Uint8Array([66]) }).body,
    );
    // Without the escape this part arrived at the far side as a FILE named
    // x.sh, from a call that declared no filename at all.
    expect(text).toContain('name="a%22; filename=%22x.sh"');
    expect(text).not.toContain('filename="x.sh"');
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
    // mostly invalid UTF-8. Located by scanning for the header terminator rather
    // than by offset arithmetic, so the test does not encode the header's exact
    // length — and then compared BYTE FOR BYTE at that offset. A `toContain` over
    // the comma-joined runs is not an identity check: `"0,128,255,254,127"` is a
    // substring of `"10,128,255,254,127"`, so the first byte could be wrong.
    const bytes = new Uint8Array([0x00, 0x80, 0xff, 0xfe, 0x7f]);
    const { body } = multipartBody({ name: "f", filename: "x.bin", bytes });
    const start = indexOfBytes(body, new TextEncoder().encode("\r\n\r\n"));
    expect(start).toBeGreaterThan(-1);
    const payloadAt = start + 4;
    expect(body.subarray(payloadAt, payloadAt + bytes.length)).toEqual(bytes);
    // And the round trip really would have lost them, so the assertion above is
    // testing something.
    const roundTripped = new TextEncoder().encode(new TextDecoder().decode(bytes));
    expect(roundTripped).not.toEqual(bytes);
  });

  test("a LIST part is byte-identical to the same content passed as one buffer", () => {
    // The whole claim behind widening `MultipartPart.bytes`: a caller holding a
    // header and the samples it describes may hand both over instead of joining
    // them, and nothing about the request changes. Compared against a body built
    // from the joined bytes with the SAME boundary, since the boundary is random
    // per call — so the two bodies are directly comparable rather than compared
    // modulo a substitution.
    // Pinned so both calls mint the SAME boundary — `multipartBody` draws it
    // from `Math.random()` and `Date.now()` per call. `restoreMocks` puts both
    // back before the next test.
    vi.spyOn(Math, "random").mockReturnValue(0.42);
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    const header = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    const payload = new Uint8Array([0x00, 0x80, 0xff, 0xfe, 0x7f]);
    const joined = new Uint8Array([...header, ...payload]);

    const asList = multipartBody({
      name: "audio",
      filename: "clip.wav",
      type: "audio/wav",
      bytes: [header, payload],
    });
    const asBuffer = multipartBody({
      name: "audio",
      filename: "clip.wav",
      type: "audio/wav",
      bytes: joined,
    });

    // Byte-identical OUTRIGHT, which is only assertable because the boundary was
    // pinned above. Comparing modulo a substituted boundary was the first draft
    // and it hid a real trap: `Math.random().toString(36).slice(2)` is
    // VARIABLE-LENGTH, so two calls routinely produce boundaries of different
    // lengths and any assertion about the bodies' sizes fails a few runs in a
    // hundred — a flake in a test whose whole subject is that two spellings
    // agree byte for byte.
    expect(asList.body).toEqual(asBuffer.body);
    expect(asList.headers).toEqual(asBuffer.headers);
  });

  test("a list of MANY chunks is concatenated in order, and an empty list is a field", () => {
    // Two shapes the two-chunk case does not cover: the loop really walks the
    // list rather than reading its first entry, and a part with no bytes at all
    // is still a well-formed part rather than a body with a hole in it.
    const many = multipartBody({
      name: "f",
      bytes: [
        new TextEncoder().encode("a"),
        new TextEncoder().encode("b"),
        new TextEncoder().encode("c"),
      ],
    });
    expect(new TextDecoder().decode(many.body)).toContain('name="f"\r\n\r\nabc\r\n');

    const none = multipartBody({ name: "f", bytes: [] });
    expect(new TextDecoder().decode(none.body)).toContain('name="f"\r\n\r\n\r\n--');
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

describe("the unpublished fallback and a streaming body", () => {
  test("adds duplex: half for an async iterable, which undici refuses without", async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      seen.push(init);
      return Promise.resolve(new Response("ok"));
    });
    async function* windows(): AsyncIterable<Uint8Array> {
      yield new Uint8Array([1, 2, 3]);
    }
    await stepFetch("https://upload.test/v2/upload", { method: "POST", body: windows() });
    // The promise `StepFetchInit.body` makes: the caller passes only the
    // iterable. It held for a deployed run and broke for every other caller.
    expect((seen[0] as { duplex?: string }).duplex).toBe("half");
  });

  test("does NOT add it for bytes or a string — a duplex on those is its own rejection", async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      seen.push(init);
      return Promise.resolve(new Response("ok"));
    });
    await stepFetch("https://upload.test/a", { method: "POST", body: new Uint8Array([1]) });
    await stepFetch("https://upload.test/b", { method: "POST", body: "{}" });
    await stepFetch("https://upload.test/c");
    for (const init of seen) expect((init as { duplex?: string }).duplex).toBeUndefined();
    expect(seen).toHaveLength(3);
  });
});
