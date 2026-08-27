// Copyright 2026 the AAI authors. MIT license.
/**
 * The third `SessionStateBackend`.
 *
 * It is a proxy, so what matters is the two agreements the seam depends on — the
 * memory backend is a valid test double for the others only because all three
 * behave the same way — plus what it does with an answer it cannot read.
 *
 * Both agreements fail SILENTLY if broken:
 *
 * - `countEvents` must be the platform's `max + 1`, never derived from a length.
 *   Under a length a resumed session restarts its log at a position it has already
 *   used, its `tail` goes backwards, and the re-appended events are dropped by the
 *   platform's `on conflict do nothing`.
 * - The event INDICES travel as they are. They were assigned above this backend and
 *   a client has already been told them, so renumbering hands out positions that
 *   were never promised.
 */

import { describe, expect, test, vi } from "vitest";
import { createPlatformStateBackend } from "./session-state-platform.ts";

const BASE = "https://api.test/my-agent";
const TOKEN = "sandbox-bearer";

function recordingPlatform(answer: () => Response = () => Response.json({ result: null })) {
  const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    calls.push({
      url: req.url,
      headers: req.headers,
      body: JSON.parse(await req.text()) as Record<string, unknown>,
    });
    return answer();
  };
  return { calls, fetch };
}

const backendWith = (answer?: () => Response) => {
  const platform = recordingPlatform(answer);
  return {
    backend: createPlatformStateBackend({ base: BASE, token: TOKEN, fetch: platform.fetch }),
    ...platform,
  };
};

describe("what it reports about itself", () => {
  test("names itself platform and claims durability", () => {
    // The flag drives the "Session mode resolved" line an operator reads, and a
    // backend claiming durability it does not have is worse than one admitting
    // memory. It is earned here: a committed value is a row in the platform's
    // database, which outlives every sandbox.
    const { backend } = backendWith();
    expect(backend.name).toBe("platform");
    expect(backend.durable).toBe(true);
  });
});

describe("what crosses to the platform", () => {
  test("posts to the agent's own route with its bearer", async () => {
    const { backend, calls } = backendWith(() => Response.json({ result: {} }));
    await backend.load("sess_1");
    expect(calls[0]?.url).toBe(`${BASE}/session-state`);
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  test("tolerates a trailing slash on the operator-set base", async () => {
    const platform = recordingPlatform(() => Response.json({ result: {} }));
    const backend = createPlatformStateBackend({
      base: `${BASE}///`,
      token: TOKEN,
      fetch: platform.fetch,
    });
    await backend.load("sess_1");
    expect(platform.calls[0]?.url).toBe(`${BASE}/session-state`);
  });

  test("commits only the slots it was given", async () => {
    // The store above calls `commit` with the CHANGED slots only, so the map is
    // small even when the session's state is not.
    const { backend, calls } = backendWith();
    await backend.commit("sess_1", new Map([["cart", '"a"']]));
    expect(calls[0]?.body).toEqual({
      method: "commit",
      sessionId: "sess_1",
      values: { cart: '"a"' },
    });
  });

  /**
   * The indices travel as they are.
   *
   * They were assigned above this backend and a client has already been told them,
   * so renumbering here hands out positions that were never promised.
   */
  test("sends event indices unchanged, and the runtime's json as the wire's event", async () => {
    const { backend, calls } = backendWith();
    await backend.appendEvents("sess_1", [
      { index: 7, json: '{"t":"a"}' },
      { index: 9, json: '{"t":"b"}' },
    ]);
    expect(calls[0]?.body.events).toEqual([
      { index: 7, event: '{"t":"a"}' },
      { index: 9, event: '{"t":"b"}' },
    ]);
  });

  test("appending nothing crosses nothing", async () => {
    const { backend, calls } = backendWith();
    await backend.appendEvents("sess_1", []);
    expect(calls).toEqual([]);
  });
});

describe("what it makes of an answer", () => {
  test("loads slots into a Map, ignoring anything that is not a string", async () => {
    const { backend } = backendWith(() =>
      Response.json({ result: { cart: '"a"', broken: 7, nested: { x: 1 } } }),
    );
    expect(await backend.load("sess_1")).toEqual(new Map([["cart", '"a"']]));
  });

  test("a fresh session loads an empty Map rather than failing", async () => {
    const { backend } = backendWith(() => Response.json({ result: {} }));
    expect(await backend.load("sess_1")).toEqual(new Map());
  });

  test("reads events back as the runtime's shape", async () => {
    const { backend } = backendWith(() =>
      Response.json({ result: [{ index: 3, event: '{"t":"a"}' }] }),
    );
    expect(await backend.readEvents("sess_1", 0, 10)).toEqual([{ index: 3, json: '{"t":"a"}' }]);
  });

  test("drops a malformed event rather than guessing its index", async () => {
    const { backend } = backendWith(() =>
      Response.json({
        result: [
          { index: "x", event: "{}" },
          { index: 1, event: "{}" },
        ],
      }),
    );
    expect(await backend.readEvents("sess_1", 0, 10)).toEqual([{ index: 1, json: "{}" }]);
  });

  test("takes countEvents from the platform, which computes max + 1", async () => {
    const { backend } = backendWith(() => Response.json({ result: 10 }));
    expect(await backend.countEvents("sess_1")).toBe(10);
  });

  /**
   * NOT defaulted to 0, and this is the one that would be silent.
   *
   * A resumed session that restarts its log at 0 overwrites its own history, so an
   * answer this code cannot read has to fail the hydrate rather than guess.
   */
  test.each([
    ["a string", () => Response.json({ result: "ten" })],
    ["null", () => Response.json({ result: null })],
    ["a negative", () => Response.json({ result: -1 })],
    ["a fraction", () => Response.json({ result: 1.5 })],
  ])("refuses %s from countEvents rather than defaulting to 0", async (_label, answer) => {
    const { backend } = backendWith(answer);
    await expect(backend.countEvents("sess_1")).rejects.toThrow(/countEvents/);
  });
});

describe("failures propagate", () => {
  test.each([401, 404, 501, 503])("rejects on HTTP %i, carrying the status", async (status) => {
    // The store above has its own policy — `hydrate` rejects and fails the session
    // start, `flush` logs — so this must not decide for it.
    const { backend } = backendWith(() => Response.json({ error: "no" }, { status }));
    await expect(backend.load("sess_1")).rejects.toThrow(new RegExp(`HTTP ${status}`));
  });

  test("rejects a 200 with no result", async () => {
    const { backend } = backendWith(() => Response.json({ ok: true }));
    await expect(backend.load("sess_1")).rejects.toThrow(/without a result/);
  });

  test("propagates a transport failure", async () => {
    const backend = createPlatformStateBackend({
      base: BASE,
      token: TOKEN,
      fetch: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    });
    await expect(backend.discard("sess_1")).rejects.toThrow(/ECONNREFUSED/);
  });
});
