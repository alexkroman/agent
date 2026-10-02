// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { progressOf, sendViaXhr, type UploadXhr, uploadXhrClass } from "./_upload-progress.ts";
import type { UploadProgress } from "./workflow-upload-client.ts";

describe("progressOf", () => {
  test("answers the fraction of a known total", () => {
    expect(progressOf(2, 8)).toEqual({ loaded: 2, total: 8, fraction: 0.25 });
  });

  test("clamps a transport that over-reports to 1", () => {
    expect(progressOf(9, 8).fraction).toBe(1);
  });

  test("has no fraction for an unknown or zero total, rather than NaN", () => {
    expect(progressOf(3, undefined).fraction).toBeUndefined();
    expect(progressOf(0, 0).fraction).toBeUndefined();
  });
});

describe("uploadXhrClass", () => {
  test("answers undefined where there is no XMLHttpRequest — Node's shape", () => {
    vi.stubGlobal("XMLHttpRequest", undefined);
    expect(uploadXhrClass()).toBeUndefined();
  });

  test("answers the global constructor when there is one", () => {
    vi.stubGlobal("XMLHttpRequest", ScriptedXhr);
    expect(uploadXhrClass()).toBe(ScriptedXhr);
  });
});

type ProgressListener = (event: {
  loaded: number;
  total: number;
  lengthComputable: boolean;
}) => void;

/** A scriptable XHR implementing exactly `UploadXhr`; the last one built is the call's. */
class ScriptedXhr implements UploadXhr {
  static last: ScriptedXhr | undefined;
  opened: [string, string] | undefined;
  headers: Record<string, string> = {};
  sent: unknown;
  aborted = false;
  status = 200;
  statusText = "OK";
  responseText = '{"ok":true}';
  readonly #handlers = new Map<string, () => void>();
  #progress: ProgressListener = () => undefined;
  readonly upload = {
    addEventListener: (_type: "progress", listener: ProgressListener) => {
      this.#progress = listener;
    },
  };

  constructor() {
    ScriptedXhr.last = this;
  }
  open(method: string, url: string): void {
    this.opened = [method, url];
  }
  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }
  send(body: unknown): void {
    this.sent = body;
  }
  abort(): void {
    this.aborted = true;
    this.fire("abort");
  }
  addEventListener(type: "load" | "error" | "timeout" | "abort", listener: () => void): void {
    this.#handlers.set(type, listener);
  }
  getResponseHeader(name: string): string | null {
    return name === "Content-Type" ? "application/json" : null;
  }
  fire(type: "load" | "error" | "timeout" | "abort"): void {
    this.#handlers.get(type)?.();
  }
  report(loaded: number, total: number, lengthComputable = true): void {
    this.#progress({ loaded, total, lengthComputable });
  }
}

/** The instance the call under test built. */
function current(): ScriptedXhr {
  const xhr = ScriptedXhr.last;
  if (!xhr) throw new Error("no XMLHttpRequest was constructed");
  return xhr;
}

function send(signal?: AbortSignal, total: number | undefined = 8) {
  ScriptedXhr.last = undefined;
  const reports: UploadProgress[] = [];
  const response = sendViaXhr(
    ScriptedXhr,
    "PUT",
    "https://agents.example/a/uploads/upl_1",
    { authorization: "Bearer t" },
    new Uint8Array(8),
    total,
    (progress) => reports.push(progress),
    signal,
  );
  return { response, reports };
}

describe("sendViaXhr", () => {
  test("sends the request it was given and resolves a Response from the load", async () => {
    const { response } = send();
    const xhr = current();
    expect(xhr.opened).toEqual(["PUT", "https://agents.example/a/uploads/upl_1"]);
    expect(xhr.headers).toEqual({ authorization: "Bearer t" });
    expect(xhr.sent).toBeInstanceOf(Uint8Array);
    xhr.fire("load");
    const res = await response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("reports progress on the event's own total, or the measured one when it has none", () => {
    const { reports } = send(undefined, 8);
    current().report(2, 4);
    current().report(6, 0, false);
    expect(reports).toEqual([
      { loaded: 2, total: 4, fraction: 0.5 },
      { loaded: 6, total: 8, fraction: 0.75 },
    ]);
  });

  test("builds a body-less Response for a 204", async () => {
    const { response } = send();
    current().status = 204;
    current().fire("load");
    expect(await (await response).text()).toBe("");
  });

  test.each(["error", "timeout"] as const)(
    "rejects a transport %s as a TypeError",
    async (type) => {
      const { response } = send();
      current().fire(type);
      await expect(response).rejects.toThrow(TypeError);
    },
  );

  test("rejects a status of 0, which no Response can carry", async () => {
    const { response } = send();
    current().status = 0;
    current().fire("load");
    await expect(response).rejects.toThrow(/did not reach the agent/);
  });

  test("an abort aborts the request and rejects with the signal's own reason", async () => {
    const controller = new AbortController();
    const { response } = send(controller.signal);
    const reason = new Error("user cancelled");
    controller.abort(reason);
    await expect(response).rejects.toBe(reason);
    expect(current().aborted).toBe(true);
  });

  test("a signal already aborted never sends", async () => {
    const controller = new AbortController();
    controller.abort(new Error("too late"));
    const { response } = send(controller.signal);
    await expect(response).rejects.toThrow("too late");
    expect(current().sent).toBeUndefined();
  });
});
