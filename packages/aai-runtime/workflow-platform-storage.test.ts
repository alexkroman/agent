// Copyright 2026 the AAI authors. MIT license.
/**
 * The guest's Storage client.
 *
 * It is a proxy, so most of what could go wrong is in the two things it does own:
 * the SHAPE it presents (eleven methods across four groups, because the DevKit's
 * runtime reaches them by name and a missing one is a `TypeError` deep in a
 * replay), and what it does with a reply it does not understand.
 *
 * The binary round trip lives in `workflow-typed-json.test.ts`. What is asserted
 * here is that this client really uses that codec rather than plain JSON — which is
 * the mistake that corrupts a run's input with no error anywhere.
 */

import { describe, expect, test, vi } from "vitest";
import {
  callPlatformStorage,
  createPlatformStorage,
  type PlatformStorageOptions,
} from "./workflow-platform-storage.ts";

const BASE = "https://api.test/my-agent";
const TOKEN = "sandbox-bearer";

/** Records what crossed and answers as the platform would. */
function recordingPlatform(answer: () => Response = () => Response.json({ result: { ok: true } })) {
  const calls: { url: string; method: string; headers: Headers; body: string }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    calls.push({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: await req.text(),
    });
    return answer();
  };
  return { calls, fetch };
}

function storageWith(answer?: () => Response) {
  const platform = recordingPlatform(answer);
  const opts: PlatformStorageOptions = { base: BASE, token: TOKEN, fetch: platform.fetch };
  return { storage: createPlatformStorage(opts), opts, ...platform };
}

/** The request body the platform received, parsed. */
function sent(raw: string | undefined): { method: string; args: unknown[] } {
  return JSON.parse(raw ?? "{}") as { method: string; args: unknown[] };
}

describe("the shape it presents", () => {
  /**
   * The DevKit's runtime reaches these by name — `getWorld().runs.get(...)` — so a
   * missing one is a `TypeError` inside a replay, several layers from here.
   */
  test.each([
    ["runs", ["get", "list"]],
    ["steps", ["get", "list"]],
    ["events", ["create", "get", "list", "listByCorrelationId"]],
    ["hooks", ["get", "getByToken", "list"]],
  ] as const)("%s exposes exactly %o", (group, methods) => {
    const { storage } = storageWith();
    const entries = Object.entries(storage[group]);
    expect(entries.map(([name]) => name).sort((a, b) => a.localeCompare(b))).toEqual(
      [...methods].sort((a, b) => a.localeCompare(b)),
    );
    for (const [, fn] of entries) expect(typeof fn).toBe("function");
  });

  test("is eleven methods in total, matching their Storage interface", () => {
    const { storage } = storageWith();
    const total = [storage.runs, storage.steps, storage.events, storage.hooks].reduce(
      (sum, group) => sum + Object.keys(group).length,
      0,
    );
    expect(total).toBe(11);
  });
});

describe("what crosses to the platform", () => {
  test("posts to the agent's own storage route with its bearer", async () => {
    const { storage, calls } = storageWith();
    await storage.runs.get("run_1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(`${BASE}/workflow-storage`);
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  test("tolerates a trailing slash on the base, which is operator-set", async () => {
    const platform = recordingPlatform();
    const storage = createPlatformStorage({
      base: `${BASE}//`,
      token: TOKEN,
      fetch: platform.fetch,
    });
    await storage.runs.get("run_1");
    expect(platform.calls[0]?.url).toBe(`${BASE}/workflow-storage`);
  });

  test("names the dotted method and forwards every argument in order", async () => {
    const { storage, calls } = storageWith();
    await storage.steps.get("run_1", "step_2", { resolveData: "none" });
    const body = sent(calls[0]?.body);
    expect(body.method).toBe("steps.get");
    expect(body.args).toEqual(["run_1", "step_2", { resolveData: "none" }]);
  });

  test("forwards a call with no arguments as an empty array", async () => {
    const { storage, calls } = storageWith();
    await storage.runs.list();
    expect(sent(calls[0]?.body)).toEqual({ method: "runs.list", args: [] });
  });

  /**
   * The mistake that corrupts a run silently.
   *
   * A run's input is a `Uint8Array`, and plain `JSON.stringify` turns it into an
   * index map. This asserts the ENVELOPE is on the wire, which is what says the
   * shared codec was used rather than `JSON.stringify`.
   */
  test("encodes binary arguments as the DevKit's envelope, not an index map", async () => {
    const { storage, calls } = storageWith();
    await storage.events.create("run_1", {
      type: "run_created",
      runInput: { input: new Uint8Array([7, 0, 255]) },
    });
    const body = sent(calls[0]?.body);
    const input = (body.args[1] as { runInput: { input: { __type: string; data: string } } })
      .runInput.input;
    expect(input.__type).toBe("Uint8Array");
    expect(input.data).toBe(Buffer.from([7, 0, 255]).toString("base64"));
  });

  test("decodes binary in the REPLY back to a Uint8Array", async () => {
    const { storage } = storageWith(() =>
      Response.json({
        result: {
          runId: "run_1",
          input: { __type: "Uint8Array", data: Buffer.from([1, 2]).toString("base64") },
        },
      }),
    );
    const run = (await storage.runs.get("run_1")) as { input: unknown };
    expect(run.input).toBeInstanceOf(Uint8Array);
    expect(run.input).toEqual(new Uint8Array([1, 2]));
  });
});

describe("the reply", () => {
  test("unwraps `result` rather than handing back the envelope", async () => {
    const { storage } = storageWith(() => Response.json({ result: { runId: "run_1" } }));
    await expect(storage.runs.get("run_1")).resolves.toEqual({ runId: "run_1" });
  });

  test("passes a null result through, which is a legitimate answer", async () => {
    // `runs.get` for a run the platform knows nothing about answers null rather
    // than failing, and a client that treated null as "no result" would turn that
    // into an error the DevKit does not expect.
    const { storage } = storageWith(() => Response.json({ result: null }));
    await expect(storage.runs.get("run_1")).resolves.toBeNull();
  });

  test.each([
    [400, "unknown storage method"],
    [401, "unauthorized"],
    [404, "no such run"],
    [501, "platform run storage not configured"],
    [503, "storage call failed"],
  ])(
    "rejects on HTTP %i, carrying the status and the platform's message",
    async (status, message) => {
      // The status is what tells a reader where to look: a 400 is a call this client
      // built wrongly, a 404 is a run this agent does not own, a 501 is a deployment
      // with no storage, a 503 is worth retrying.
      const { storage } = storageWith(() => Response.json({ error: message }, { status }));
      await expect(storage.runs.get("run_1")).rejects.toThrow(
        new RegExp(`runs\\.get answered HTTP ${status}[\\s\\S]*${message}`),
      );
    },
  );

  test.each([
    ["no result key", () => Response.json({ ok: true })],
    ["a bare array", () => Response.json([1, 2])],
    ["a body that is not JSON", () => new Response("ok", { status: 200 })],
  ])("rejects a 200 with %s", async (_label, answer) => {
    // Returning undefined would look like "no such run" to every caller; throwing
    // fails the step, which the platform's queue retries.
    const { storage } = storageWith(answer);
    await expect(storage.runs.get("run_1")).rejects.toThrow();
  });

  test("propagates a transport failure rather than swallowing it", async () => {
    const storage = createPlatformStorage({
      base: BASE,
      token: TOKEN,
      fetch: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    });
    await expect(storage.hooks.get("h1")).rejects.toThrow(/ECONNREFUSED/);
  });
});

test("callPlatformStorage is usable directly, and names the method it failed on", async () => {
  const platform = recordingPlatform(() => new Response("nope", { status: 500 }));
  await expect(
    callPlatformStorage({ base: BASE, token: TOKEN, fetch: platform.fetch }, "events.list", [
      { runId: "r1" },
    ]),
  ).rejects.toThrow(/events\.list answered HTTP 500/);
});
