// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the upload call's PROGRESS half.
 *
 * The request this builds is pinned next door in `workflow-api-client.test.ts`
 * along with every other route. What is asserted here is the thing that is
 * unique to this one: asking for progress swaps the transport, and the two
 * transports have to be indistinguishable in every respect but the reports —
 * same URL, same headers, same body, same failures, same abort. A divergence
 * there is invisible in a diff and shows up as a route that works in Node and
 * not in a browser, or the reverse.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createWorkflowApiClient } from "./workflow-api-client.ts";
import type { UploadProgress } from "./workflow-upload-client.ts";

const BASE = "https://agents.example/my-agent/";

/** The stored-upload body the route answers with. */
const STORED = { id: "upl_1", name: "call.wav", type: "audio/wav", size: 8 };

function client() {
  return createWorkflowApiClient({ baseUrl: BASE });
}

/** What an XHR progress event carries, as the adapter reads it. */
type ProgressEvent = { loaded: number; total: number; lengthComputable: boolean };

/**
 * A scriptable `XMLHttpRequest`.
 *
 * Node has none — which is the fallback path these specs also cover — and
 * jsdom's would dial the test origin, so the only way to assert what the
 * adapter does with `upload.progress`, `load`, `error` and `abort` is to drive
 * them. It implements exactly the members `UploadXhr` names, so a widened
 * dependency fails to compile here rather than at run time in one browser.
 */
class FakeXhr {
  /** The most recent instance, which is the one a spec just caused. */
  static last: FakeXhr | undefined;
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown;
  aborted = false;
  status = 200;
  statusText = "OK";
  responseText = JSON.stringify(STORED);
  contentType: string | null = "application/json";
  #handlers = new Map<string, (() => void)[]>();
  #progress: ((event: ProgressEvent) => void)[] = [];

  readonly upload = {
    addEventListener: (_type: "progress", listener: (event: ProgressEvent) => void): void => {
      this.#progress.push(listener);
    },
  };

  constructor() {
    FakeXhr.last = this;
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  addEventListener(type: string, listener: () => void): void {
    this.#handlers.set(type, [...(this.#handlers.get(type) ?? []), listener]);
  }

  send(body: unknown): void {
    this.body = body;
  }

  abort(): void {
    this.aborted = true;
    this.fire("abort");
  }

  getResponseHeader(name: string): string | null {
    return name === "Content-Type" ? this.contentType : null;
  }

  /** Drive one `upload.progress` event. */
  report(loaded: number, total: number, lengthComputable = true): void {
    for (const listener of this.#progress) listener({ loaded, total, lengthComputable });
  }

  /** Drive the named lifecycle event. */
  fire(type: "load" | "error" | "timeout" | "abort"): void {
    for (const listener of this.#handlers.get(type) ?? []) listener();
  }
}

/** Install the fake and answer the next `load` with `STORED`. */
function installXhr(): void {
  FakeXhr.last = undefined;
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
}

/**
 * The instance the call under test constructed.
 *
 * A `throw` rather than `expect.fail`: this runs outside a test body, where an
 * assertion is a biome finding, and the message reaches the reporter either way.
 */
function xhr(): FakeXhr {
  const instance = FakeXhr.last;
  if (!instance) throw new Error("the upload did not construct an XMLHttpRequest");
  return instance;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(STORED), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  // No `XMLHttpRequest` unless a spec installs one: that is the Node shape, and
  // it must be the starting point rather than whatever the previous spec left.
  vi.stubGlobal("XMLHttpRequest", undefined);
});

afterEach(() => {
  // `restoreMocks` covers spies and `unstubEnvs` covers env vars; neither undoes
  // a stubbed global, and a leaked `XMLHttpRequest` would silently move every
  // later spec in the run onto the other transport.
  vi.unstubAllGlobals();
});

describe("upload progress", () => {
  test("asking for none leaves the call on fetch, with no reports", async () => {
    installXhr();
    await client().upload("bytes", { name: "a.txt" });
    // The transport swap is opt-in: a caller with nothing to draw must not be
    // moved onto a second code path for free.
    expect(FakeXhr.last).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("reports both ends on fetch, since a request body is not observable there", async () => {
    const seen: UploadProgress[] = [];
    await client().upload(new Blob(["abcdefgh"]), {
      name: "a.bin",
      onProgress: (progress) => seen.push(progress),
    });
    // Sending, then sent — the honest degradation where no transport can say
    // more. The leading zero is what makes a bar exist from the submit rather
    // than from whenever the first chunk clears.
    expect(seen).toEqual([
      { loaded: 0, total: 8, fraction: 0 },
      { loaded: 8, total: 8, fraction: 1 },
    ]);
  });

  test("reports the transport's own byte counts when there is an XMLHttpRequest", async () => {
    installXhr();
    const seen: UploadProgress[] = [];
    const stored = client().upload(new Blob(["abcdefgh"]), {
      name: "call.wav",
      onProgress: (progress) => seen.push(progress),
    });
    xhr().report(2, 8);
    xhr().report(6, 8);
    xhr().fire("load");

    await expect(stored).resolves.toMatchObject({ id: "upl_1" });
    expect(seen).toEqual([
      { loaded: 0, total: 8, fraction: 0 },
      { loaded: 2, total: 8, fraction: 0.25 },
      { loaded: 6, total: 8, fraction: 0.75 },
      // Reported after the answer landed, so a bar cannot rest short of full
      // because the last chunk event raced the response.
      { loaded: 8, total: 8, fraction: 1 },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("builds the SAME request on the other transport", async () => {
    installXhr();
    const stored = client().upload(new Blob(["abcdefgh"], { type: "audio/wav" }), {
      name: "my call.wav",
      onProgress: vi.fn(),
    });
    xhr().fire("load");
    await stored;

    // The URL, the method, the type header and the body are the whole request,
    // and a divergence in any of them is a route that works on one transport.
    expect(xhr().method).toBe("POST");
    expect(xhr().url).toBe(`${BASE}workflows/uploads?name=my%20call.wav`);
    expect(xhr().headers["Content-Type"]).toBe("audio/wav");
    expect(xhr().body).toBeInstanceOf(Blob);
  });

  test("resolves the URL from THIS client's base, not from the answer", async () => {
    installXhr();
    const stored = client().upload("bytes", { name: "a.txt", onProgress: vi.fn() });
    xhr().fire("load");
    // Same rule as the fetch path: the agent knows its own paths and not the
    // origin it was reached on.
    await expect(stored).resolves.toMatchObject({ url: `${BASE}workflows/uploads/upl_1` });
  });

  test("a refusal still carries the agent's own sentence", async () => {
    installXhr();
    const stored = client().upload("bytes", { name: "a.txt", onProgress: vi.fn() });
    const instance = xhr();
    instance.status = 413;
    instance.statusText = "Payload Too Large";
    instance.responseText = JSON.stringify({ error: "upload exceeds 268435456 bytes" });
    instance.fire("load");
    await expect(stored).rejects.toThrow("upload exceeds 268435456 bytes");
  });

  test("a 2xx that is not JSON reports the surface and a preview, not a SyntaxError", async () => {
    installXhr();
    const stored = client().upload("bytes", { name: "a.txt", onProgress: vi.fn() });
    const instance = xhr();
    instance.contentType = "text/html";
    instance.responseText = "<html><body>502 Bad Gateway</body></html>";
    instance.fire("load");
    // The guard above the transports, reached identically from both.
    await expect(stored).rejects.toThrow(
      "Workflow API 200: <html><body>502 Bad Gateway</body></html>",
    );
  });

  test("a transport failure is an error, never a Response with status 0", async () => {
    installXhr();
    const stored = client().upload("bytes", { name: "a.txt", onProgress: vi.fn() });
    xhr().fire("error");
    await expect(stored).rejects.toThrow(/did not reach the agent/);
  });

  test("a status of 0 on load is the same failure, since no Response can carry it", async () => {
    installXhr();
    const stored = client().upload("bytes", { name: "a.txt", onProgress: vi.fn() });
    const instance = xhr();
    instance.status = 0;
    instance.fire("load");
    await expect(stored).rejects.toThrow(/did not reach the agent/);
  });

  test("an abort aborts the request and rejects with the signal's own reason", async () => {
    installXhr();
    const controller = new AbortController();
    const reason = new Error("the reader navigated away");
    const stored = client().upload("bytes", {
      name: "a.txt",
      onProgress: vi.fn(),
      signal: controller.signal,
    });
    controller.abort(reason);
    await expect(stored).rejects.toThrow(reason);
    expect(xhr().aborted).toBe(true);
  });

  test("a signal already aborted never sends at all", async () => {
    installXhr();
    const stored = client().upload("bytes", {
      name: "a.txt",
      onProgress: vi.fn(),
      signal: AbortSignal.abort(new Error("gone")),
    });
    await expect(stored).rejects.toThrow("gone");
    expect(xhr().body).toBeUndefined();
  });

  test("a total the transport cannot state is reported as UNKNOWN, not as zero", async () => {
    // A string body's byte length is its UTF-8 encoding's, and measuring it
    // means encoding the whole thing again to draw a bar. On fetch it stays
    // unknown, which is what a bar renders as indeterminate.
    const seen: UploadProgress[] = [];
    await client().upload("héllo", { name: "a.txt", onProgress: (p) => seen.push(p) });
    expect(seen).toEqual([
      { loaded: 0, total: undefined, fraction: undefined },
      { loaded: 0, total: undefined, fraction: undefined },
    ]);
  });

  test("an event with no computable length keeps the measured total's scale", async () => {
    installXhr();
    const seen: UploadProgress[] = [];
    const stored = client().upload(new Blob(["abcdefgh"]), {
      name: "a.bin",
      onProgress: (p) => seen.push(p),
    });
    xhr().report(4, 0, false);
    xhr().fire("load");
    await stored;
    // The event's own total is 0 here, which would restart the bar at nothing;
    // the measured size is the honest denominator.
    expect(seen[1]).toEqual({ loaded: 4, total: 8, fraction: 0.5 });
  });

  test("a zero-byte body has no fraction rather than a NaN one", async () => {
    const seen: UploadProgress[] = [];
    await client().upload(new Blob([]), { name: "empty.bin", onProgress: (p) => seen.push(p) });
    // `0 / 0` renders as a bar of no width labelled `NaN%`.
    expect(seen.every((progress) => progress.fraction === undefined)).toBe(true);
    expect(seen).toHaveLength(2);
  });
});
