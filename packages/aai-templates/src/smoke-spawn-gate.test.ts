// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * `scripts/smoke-spawn.mjs` — the one check on the deploy path that OBSERVES a
 * sandbox rather than predicting one.
 *
 * It is guarded here for the reason its deleted predecessors were: it runs only
 * on a push to main, so nothing reads it before production does, and its whole
 * success output is `sandbox spawned and brokered … ✓`. Several ways of being
 * wrong print exactly that — a broker loop that accepted any 200, a settings
 * read that treated a missing key as "skip", a cleanup that fired on the
 * success path only. Each would leave the deploy green over the failure this
 * script exists to catch.
 *
 * Every collaborator is injected (`fetchImpl`, `sleep`, `now`), so the timeout
 * path is asserted without a test that waits one out — this suite is unit tier
 * and touches neither the network nor the clock.
 */

import { describe, expect, test } from "vitest";
import { sole } from "./_gate-support.ts";

type Attempt = { url: string; init: RequestInit | undefined };

const smoke = sole(
  import.meta.glob<{
    smokeSlug: (random?: () => string) => string;
    smokeDeployBody: (slug: string) => Record<string, unknown>;
    readSettings: (env: Record<string, string | undefined>) => { base: string; key: string };
    brokerSandbox: (args: {
      base: string;
      slug: string;
      fetchImpl?: typeof fetch;
      sleep?: (ms: number) => Promise<unknown>;
      now?: () => number;
      timeoutMs?: number;
      intervalMs?: number;
      log?: (line: string) => void;
    }) => Promise<{ ok: boolean; attempts: number; detail: string }>;
    main: (argv: string[], env: Record<string, string | undefined>) => Promise<number>;
  }>("../../../scripts/smoke-spawn.mjs", { eager: true }),
);

/**
 * A fake `fetch` that records what it was asked for.
 *
 * A typed seam rather than a cast per test, for the reason the spec this
 * replaced gave: `typeof fetch` is satisfiable by an ordinary arrow under
 * contextual typing, and a cast stops reporting the moment the thing it stands
 * in for changes shape. The recording is what lets a test assert the script
 * BROKERS rather than merely pings, and that it cleans up.
 */
function fakeFetch(handler: (url: string, init: RequestInit | undefined) => Response): {
  fetchImpl: typeof fetch;
  calls: Attempt[];
} {
  const calls: Attempt[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  };
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The collaborators every broker test injects, so nothing waits or logs. */
const inert = { sleep: async () => undefined, log: () => undefined };

/** A clock that advances by `step` on every read, so a deadline is reachable. */
function steppingClock(step: number): () => number {
  let clock = 0;
  return () => {
    clock += step;
    return clock;
  };
}

describe("the settings it refuses to run without", () => {
  test("names each missing variable and the secret it comes from", () => {
    // A gate that no-ops when unconfigured is indistinguishable from one that
    // passed — the shape every incident in this pipeline's history has. Both
    // must be a hard failure, and the message must carry the remedy.
    expect(() => smoke?.readSettings({})).toThrow(/AAI_PLATFORM_URL and AAI_API_KEY/);
    expect(() => smoke?.readSettings({ AAI_PLATFORM_URL: "https://x" })).toThrow(/AAI_API_KEY/);
    expect(() => smoke?.readSettings({ AAI_API_KEY: "k" })).toThrow(/AAI_SMOKE_API_KEY/);
  });

  test("trims a trailing slash so no URL is built with two", () => {
    expect(
      smoke?.readSettings({ AAI_PLATFORM_URL: "https://x.modal.run//", AAI_API_KEY: "k" }),
    ).toEqual({ base: "https://x.modal.run", key: "k" });
  });
});

describe("the agent it deploys", () => {
  test("takes a slug the platform's own regex accepts", () => {
    const slug = smoke?.smokeSlug(() => "abc123") ?? "";
    // `VALID_SLUG_RE` in aai/internal, restated as the assertion rather than
    // imported: this package's tsconfig cannot reach that subpath, and the
    // property worth pinning is the shape, not the constant.
    expect(slug).toMatch(/^[a-z0-9][a-z0-9_-]*[a-z0-9]$/);
    // The `-preview` suffix is owned by the studio's auto-preview deploys and
    // reaped by the orphan sweep; a smoke agent must never wear it.
    expect(slug.endsWith("-preview")).toBe(false);
  });

  test("is unique per run, so a leak cannot collide with the next one", () => {
    expect(smoke?.smokeSlug()).not.toEqual(smoke?.smokeSlug());
  });

  test("carries a worker with no bare imports", () => {
    const worker = String(smoke?.smokeDeployBody("ci-smoke-a1")?.worker ?? "");
    // A deployed worker bundle is self-contained (the CLI bundles it
    // `noExternal`), so a hand-written one that imported the SDK would exercise
    // a resolution path no real bundle uses — and fail on a difference that is
    // not about the image.
    expect(worker).not.toMatch(/^\s*import\s/m);
    expect(worker).toContain("__aaiCreateRuntime");
  });
});

describe("what counts as a spawn", () => {
  test("a brokered session URL, and nothing less", async () => {
    const { fetchImpl } = fakeFetch(() => json({ sessionUrl: "wss://sandbox/websocket" }));
    const result = await smoke?.brokerSandbox({
      base: "https://x",
      slug: "ci-smoke-a1",
      fetchImpl,
      ...inert,
    });
    expect(result).toMatchObject({ ok: true, detail: "wss://sandbox/websocket" });
  });

  test("a 200 without one keeps waiting", async () => {
    // The handler degrades to `{ sessionUrl }` when the guest cannot answer, so
    // a 200 is cheap; the session URL is what proves a sandbox was resolved.
    // Accepting the bare 200 would pass against a platform that spawns nothing.
    const { fetchImpl } = fakeFetch(() => json({ name: "ci-smoke" }));
    const now = steppingClock(5000);
    const result = await smoke?.brokerSandbox({
      base: "https://x",
      slug: "ci-smoke-a1",
      fetchImpl,
      now,
      timeoutMs: 20_000,
      intervalMs: 1000,
      ...inert,
    });
    expect(result?.ok).toBe(false);
    expect(result?.detail).toContain("no sessionUrl");
  });

  test("it retries a cold spawn rather than failing on the first pull", async () => {
    // The first spawn after a deploy pulls the whole guest image, so the early
    // attempts legitimately fail. A one-shot check here would redden every
    // healthy deploy — the failure the waiter deadlines this replaced kept
    // producing.
    let attempt = 0;
    const { fetchImpl } = fakeFetch(() =>
      ++attempt < 3 ? new Response("booting", { status: 503 }) : json({ sessionUrl: "wss://s" }),
    );
    const result = await smoke?.brokerSandbox({
      base: "https://x",
      slug: "ci-smoke-a1",
      fetchImpl,
      ...inert,
    });
    expect(result).toMatchObject({ ok: true, attempts: 3 });
  });

  test("it gives up at the deadline rather than polling forever", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("no", { status: 500 }));
    const now = steppingClock(30_000);
    const result = await smoke?.brokerSandbox({
      base: "https://x",
      slug: "ci-smoke-a1",
      fetchImpl,
      now,
      timeoutMs: 60_000,
      intervalMs: 1000,
      ...inert,
    });
    expect(result?.ok).toBe(false);
    expect(result?.detail).toContain("500");
  });
});

describe("it cleans up after itself", () => {
  test("the agent is deleted on the failure path too", async () => {
    // A `finally`, not a success-path call: a leaked agent is a row, a bundle
    // and a slug in production, and the run that leaks one is exactly the run
    // that failed.
    const { fetchImpl, calls } = fakeFetch((url) =>
      url.endsWith("/deploy") ? json({ slug: "ci-smoke-a1" }) : new Response("no", { status: 500 }),
    );
    const globalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const code = await smoke?.main(["--timeout-seconds", "1", "--interval-seconds", "1"], {
        AAI_PLATFORM_URL: "https://x",
        AAI_API_KEY: "k",
      });
      expect(code).toBe(1);
    } finally {
      globalThis.fetch = globalFetch;
    }
    expect(calls.filter((call) => call.init?.method === "DELETE")).toHaveLength(1);
  });
});
