// Copyright 2026 the AAI authors. MIT license.
import type { AnalyticsEvent } from "@alexkroman1/aai/runtime";
import { describe, expect, test, vi } from "vitest";
import { analyticsShipperFromEnv, createAnalyticsShipper } from "./analytics-shipper.ts";

function event(over: Partial<AnalyticsEvent> = {}): AnalyticsEvent {
  return { ts: 1, sessionId: "s1", kind: "user_turn", turn: 1, ...over };
}

/**
 * A fetch that records every shipment and answers 202 by default.
 *
 * Typed with `vi.fn<typeof fetch>` rather than cast into place: that is what
 * makes `mock.calls[n]` a real `[input, init]` tuple below, so the assertions
 * read the argument they mean instead of re-narrowing one.
 */
function recordingFetch(status = 202) {
  const bodies: Record<string, unknown>[] = [];
  const impl = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response("{}", { status });
  });
  return { impl, bodies, spy: impl };
}

function shipperWith(fetchImpl: typeof globalThis.fetch, over = {}) {
  return createAnalyticsShipper({
    url: "http://platform/analytics/ingest",
    token: "tok",
    slug: "my-agent",
    agentVersion: 7,
    fetchImpl,
    ...over,
  });
}

describe("analytics shipper", () => {
  test("ships buffered events with the slug, version and bearer", async () => {
    const fetcher = recordingFetch();
    const shipper = shipperWith(fetcher.impl);
    shipper.sink.record(event({ text: "hi" }));
    await shipper.flush();

    expect(fetcher.bodies[0]).toMatchObject({
      slug: "my-agent",
      agentVersion: 7,
      events: [{ sessionId: "s1", kind: "user_turn", turn: 1, text: "hi" }],
    });
    const headers = fetcher.spy.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok");
  });

  test("flushing nothing makes no request", async () => {
    const fetcher = recordingFetch();
    await shipperWith(fetcher.impl).flush();
    expect(fetcher.spy).not.toHaveBeenCalled();
  });

  test("a full batch flushes without waiting for the timer", async () => {
    const fetcher = recordingFetch();
    const shipper = shipperWith(fetcher.impl, { maxBatch: 2 });
    shipper.sink.record(event());
    shipper.sink.record(event());
    await vi.waitFor(() => expect(fetcher.spy).toHaveBeenCalled());
    expect((fetcher.bodies[0] as { events: unknown[] }).events).toHaveLength(2);
  });

  test("drops a failed shipment instead of retrying it", async () => {
    // At-most-once, deliberately: a platform outage is exactly when every
    // guest would otherwise be growing a retry queue inside a memory cap.
    const fetcher = recordingFetch(500);
    const shipper = shipperWith(fetcher.impl);
    shipper.sink.record(event());
    await shipper.flush();
    expect(shipper.dropped).toBe(1);
    await shipper.flush();
    expect(fetcher.spy).toHaveBeenCalledTimes(1);
  });

  test("a rejected fetch is a drop, not a throw into the session", async () => {
    const shipper = shipperWith(
      vi.fn<typeof globalThis.fetch>(() => Promise.reject(new Error("offline"))),
    );
    shipper.sink.record(event());
    await expect(shipper.flush()).resolves.toBeUndefined();
    expect(shipper.dropped).toBe(1);
  });

  test("a 404 stops shipping for good", async () => {
    // The platform has no analytics binding; retrying costs a request per
    // flush for the life of the sandbox and can never succeed.
    const fetcher = recordingFetch(404);
    const shipper = shipperWith(fetcher.impl);
    shipper.sink.record(event());
    await shipper.flush();
    shipper.sink.record(event());
    await shipper.flush();
    expect(fetcher.spy).toHaveBeenCalledTimes(1);
  });

  test("overflow drops the OLDEST events", async () => {
    const fetcher = recordingFetch();
    const shipper = shipperWith(fetcher.impl, { maxBatch: 100, maxBuffer: 2 });
    shipper.sink.record(event({ text: "first" }));
    shipper.sink.record(event({ text: "second" }));
    shipper.sink.record(event({ text: "third" }));
    await shipper.flush();
    const events = (fetcher.bodies[0] as { events: { text: string }[] }).events;
    expect(events.map((e) => e.text)).toEqual(["second", "third"]);
    expect(shipper.dropped).toBe(1);
  });

  test("stop() drains more than one batch — the last rows say how a session ended", async () => {
    const fetcher = recordingFetch();
    const shipper = shipperWith(fetcher.impl, { maxBatch: 1 });
    shipper.sink.record(event({ kind: "agent_turn" }));
    shipper.sink.record(event({ kind: "session_end" }));
    await shipper.stop();
    const kinds = fetcher.bodies.flatMap((b) => (b as { events: { kind: string }[] }).events);
    expect(kinds.map((e) => e.kind)).toEqual(["agent_turn", "session_end"]);
  });

  test("stop() settles when shipping fails rather than draining forever", async () => {
    // The drain loop is bounded by the buffer emptying, and a failed batch
    // empties it too (at-most-once) — so a platform outage delays an exit by
    // one request, never indefinitely.
    const fetcher = recordingFetch(500);
    const shipper = shipperWith(fetcher.impl, { maxBatch: 100 });
    shipper.sink.record(event());
    shipper.sink.record(event());
    await expect(shipper.stop()).resolves.toBeUndefined();
    expect(fetcher.spy).toHaveBeenCalledTimes(1);
    expect(shipper.dropped).toBe(2);
  });

  test("records nothing after stop", async () => {
    const fetcher = recordingFetch();
    const shipper = shipperWith(fetcher.impl);
    await shipper.stop();
    shipper.sink.record(event());
    await shipper.flush();
    expect(fetcher.spy).not.toHaveBeenCalled();
  });

  test("events recorded during a shipment go in the NEXT batch, not twice", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bodies: Record<string, unknown>[] = [];
    const impl = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      await gate;
      return new Response("{}", { status: 202 });
    });
    const shipper = shipperWith(impl);
    shipper.sink.record(event({ text: "one" }));
    const first = shipper.flush();
    shipper.sink.record(event({ text: "two" }));
    release();
    await first;
    await shipper.flush();
    const shipped = bodies.flatMap((b) => (b as { events: { text: string }[] }).events);
    expect(shipped.map((e) => e.text)).toEqual(["one", "two"]);
  });
});

describe("analyticsShipperFromEnv", () => {
  test("is absent unless the spawner configured all three values", () => {
    expect(analyticsShipperFromEnv({})).toBeUndefined();
    expect(
      analyticsShipperFromEnv({ AAI_ANALYTICS_URL: "http://x", AAI_ANALYTICS_TOKEN: "t" }),
    ).toBeUndefined();
  });

  test("builds one from a complete boot env", () => {
    const shipper = analyticsShipperFromEnv({
      AAI_ANALYTICS_URL: "http://platform/analytics/ingest",
      AAI_ANALYTICS_TOKEN: "tok",
      AAI_ANALYTICS_SLUG: "my-agent",
      AAI_ANALYTICS_VERSION: "3",
    });
    expect(shipper).toBeDefined();
    expect(shipper?.dropped).toBe(0);
  });
});
