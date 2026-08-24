// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * `scripts/wait-for-npm-versions.mjs` — the wait that stands between a release
 * and a deploy.
 *
 * It is guarded here for the reason the sibling gate specs are: its whole
 * success output is `all 3 version(s) readable from npm ✓`, and every way it can
 * be wrong prints exactly that. A packument shape it stopped understanding, a
 * `packages/*` scan that stopped matching, a poll loop that gave up after one
 * attempt — each reads as a healthy wait, and each lets through a deploy whose
 * every sandbox spawn 404s on `npm install @alexkroman1/aai@<version>`. Nothing
 * else can see it: Deploy runs on no pull request, so a break surfaces on
 * `main`, in production, on a version production cannot serve.
 *
 * Every collaborator is injected (`fetchImpl`, `sleep`, `now`), so the timeout
 * path is asserted without a test that waits one out — this suite is unit tier
 * and touches neither the network nor the clock.
 *
 * It lives in aai-templates because this package already owns the tests for
 * repo-level scripts and reaches them with raw/eager imports.
 */

import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import { sole } from "./_gate-support.ts";

type Spec = { name: string; version: string };
type Pending = Spec & { detail: string };

const wait = sole(
  import.meta.glob<{
    publishedSpecs: (root: string) => Spec[];
    specsFrom: (root: string, dirs: string[]) => Spec[];
    readVersion: (args: {
      name: string;
      version: string;
      fetchImpl?: typeof fetch;
    }) => Promise<{ readable: boolean; detail: string }>;
    waitForVersions: (args: {
      specs: Spec[];
      fetchImpl?: typeof fetch;
      sleep?: (ms: number) => Promise<unknown>;
      now?: () => number;
      timeoutMs?: number;
      intervalMs?: number;
      log?: (line: string) => void;
    }) => Promise<{ ok: boolean; attempts: number; pending: Pending[] }>;
  }>("../../scripts/wait-for-npm-versions.mjs", { eager: true }),
);

const deployWorkflow = sole(
  import.meta.glob<string>("../../.github/workflows/deploy.yml", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

/**
 * The ONE typed seam for a fake `fetch`, recording what it was asked for.
 *
 * A seam rather than a cast per test: `typeof fetch` is satisfiable by an
 * ordinary arrow under contextual typing, so the four `as unknown as typeof
 * fetch` an earlier draft of this file carried were paying for nothing — and a
 * cast stops reporting the moment the thing it stands in for changes shape.
 * The recording is what lets a test assert the script asks the INSTALLER'S
 * question rather than a cheaper one.
 */
function fakeFetch(handler: (url: string, init: RequestInit | undefined) => Response): {
  fetchImpl: typeof fetch;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  };
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** A packument holding one version, in the shape `npm install` reads. */
function packument(version: string, tarball = `https://registry.npmjs.org/x/-/x-${version}.tgz`) {
  return { versions: { [version]: { dist: { tarball } } } };
}

/** The two endpoints the script reads, answerable one at a time. */
function registryFetch(answers: { packument?: () => Response; tarball?: () => Response }) {
  const ok = () => new Response(null, { status: 200 });
  return fakeFetch((url) =>
    url.endsWith(".tgz") ? (answers.tarball ?? ok)() : (answers.packument ?? ok)(),
  );
}

describe("the packages it waits for", () => {
  test("are derived from the tree, and are the four the guest image installs", () => {
    // `fileURLToPath`, never `.pathname` — a URL pathname is percent-encoded, so
    // a checkout under a directory with a space in it would hand the script a
    // path that does not exist (the trap `scripts/_fs.mjs` documents).
    const specs = wait?.publishedSpecs(fileURLToPath(new URL("../..", import.meta.url))) ?? [];
    expect(specs.map((spec) => spec.name).sort()).toEqual([
      "@alexkroman1/aai",
      "@alexkroman1/aai-cli",
      "@alexkroman1/aai-runtime",
      "@alexkroman1/aai-ui",
    ]);
    // A real version per package: `latest` or a range would make the wait
    // unfalsifiable, since a tag always resolves.
    for (const spec of specs) expect(spec.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("refuse a list under the floor rather than reporting an empty wait green", () => {
    // The failure the floor exists for: a renamed directory or a typo'd
    // pathspec leaves the scan matching nothing, and "every version is
    // readable" is TRUE of no versions.
    expect(() => wait?.specsFrom("/repo", [])).toThrow(/only 0 publishable package/);
    expect(() => wait?.specsFrom("/repo", ["packages/aai", "packages/aai-ui"])).toThrow(
      /expected at least 4/,
    );
  });
});

describe("what counts as readable", () => {
  test("resolves against the abbreviated packument an installer reads", async () => {
    const { fetchImpl, calls } = registryFetch({
      packument: () => jsonResponse(packument("6.3.0")),
    });
    await wait?.readVersion({ name: "@alexkroman1/aai", version: "6.3.0", fetchImpl });
    expect(calls[0]?.url).toBe("https://registry.npmjs.org/%40alexkroman1%2Faai");
    // The media type is the assertion. The FULL packument is a separately-cached
    // view, so asking for that would answer a question the guest image never
    // asks — and could declare the wait over while `npm install` still 404s.
    expect(new Headers(calls[0]?.init?.headers).get("accept")).toBe(
      "application/vnd.npm.install-v1+json",
    );
    // No cache-buster on either request: the wait is about the view an installer
    // gets, so going around the cache would answer the wrong question.
    for (const call of calls) expect(call.url).not.toMatch(/[?&]/);
  });

  test("a version present in the packument whose TARBALL 404s is not readable", async () => {
    const { fetchImpl } = registryFetch({
      packument: () => jsonResponse(packument("6.3.0")),
      tarball: () => new Response(null, { status: 404 }),
    });
    // The second request is the one that fails inside the image build, and the
    // reason "the registry knows the version" is not the bar.
    await expect(
      wait?.readVersion({ name: "@alexkroman1/aai", version: "6.3.0", fetchImpl }),
    ).resolves.toEqual({ readable: false, detail: "tarball HTTP 404" });
  });

  test.each([
    [
      "a packument that does not list the version yet",
      () => jsonResponse(packument("6.2.0")),
      "not yet in the install packument",
    ],
    [
      "a packument the registry will not serve",
      () => new Response(null, { status: 500 }),
      "packument HTTP 500",
    ],
    [
      "a packument that is not JSON",
      () => new Response("<html>", { status: 200 }),
      /packument unparsable/,
    ],
  ])("%s is not readable", async (_label, answer, detail) => {
    const { fetchImpl } = registryFetch({ packument: answer });
    const result = await wait?.readVersion({
      name: "@alexkroman1/aai",
      version: "6.3.0",
      fetchImpl,
    });
    expect(result?.readable).toBe(false);
    expect(result?.detail).toMatch(detail);
  });

  test("a network error is a not-yet, never a throw", async () => {
    const { fetchImpl } = fakeFetch(() => {
      throw new Error("EAI_AGAIN");
    });
    // A DNS blip mid-release must cost another poll, not the deploy.
    await expect(
      wait?.readVersion({ name: "@alexkroman1/aai", version: "6.3.0", fetchImpl }),
    ).resolves.toEqual({ readable: false, detail: "packument unreachable (EAI_AGAIN)" });
  });

  test("both requests answering is readable", async () => {
    const { fetchImpl } = registryFetch({ packument: () => jsonResponse(packument("6.3.0")) });
    await expect(
      wait?.readVersion({ name: "@alexkroman1/aai", version: "6.3.0", fetchImpl }),
    ).resolves.toEqual({ readable: true, detail: "readable" });
  });
});

describe("waiting", () => {
  const specs: Spec[] = [
    { name: "@alexkroman1/aai", version: "6.3.0" },
    { name: "@alexkroman1/aai-ui", version: "6.3.0" },
  ];

  test("keeps polling until a mid-run publish lands", async () => {
    // The whole change: the one-shot check this replaced FAILED the deploy here,
    // and a human re-ran the job minutes later for no new information.
    let attempt = 0;
    const { fetchImpl } = fakeFetch((url) => {
      if (url.endsWith(".tgz")) return new Response(null, { status: 200 });
      attempt += 1;
      return attempt <= 4 ? jsonResponse({ versions: {} }) : jsonResponse(packument("6.3.0"));
    });
    const sleep = vi.fn(async () => undefined);

    const result = await wait?.waitForVersions({
      specs,
      fetchImpl,
      sleep,
      intervalMs: 15_000,
      timeoutMs: 600_000,
      log: () => undefined,
    });

    expect(result?.ok).toBe(true);
    expect(result?.attempts).toBe(3);
    // It actually WAITED between attempts, at the interval it was given.
    expect(sleep.mock.calls).toEqual([[15_000], [15_000]]);
  });

  test("stops re-polling a version that already read", async () => {
    const seen: string[] = [];
    const { fetchImpl } = fakeFetch((url) => {
      if (url.endsWith(".tgz")) return new Response(null, { status: 200 });
      seen.push(url);
      return url.includes("aai-ui")
        ? jsonResponse(packument("6.3.0"))
        : jsonResponse({ versions: {} });
    });
    let clock = 0;

    const result = await wait?.waitForVersions({
      specs,
      fetchImpl,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      intervalMs: 10_000,
      timeoutMs: 25_000,
      log: () => undefined,
    });

    expect(result?.ok).toBe(false);
    // aai-ui read on the first attempt and is asked once; aai never reads and is
    // asked on every attempt.
    expect(seen.filter((url) => url.includes("aai-ui"))).toHaveLength(1);
    expect(seen.filter((url) => !url.includes("aai-ui")).length).toBeGreaterThan(1);
  });

  test("gives up at the deadline, naming what is still missing and why", async () => {
    const { fetchImpl } = registryFetch({ packument: () => new Response(null, { status: 404 }) });
    let clock = 0;
    const sleeps: number[] = [];

    const result = await wait?.waitForVersions({
      specs,
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
      intervalMs: 10_000,
      timeoutMs: 25_000,
      log: () => undefined,
    });

    expect(result?.ok).toBe(false);
    // The detail travels with the spec, so the error names a cause rather than
    // "not published" — a 404 and a 500 send a reader to different places.
    expect(result?.pending).toEqual([
      { name: "@alexkroman1/aai", version: "6.3.0", detail: "packument HTTP 404" },
      { name: "@alexkroman1/aai-ui", version: "6.3.0", detail: "packument HTTP 404" },
    ]);
    // And it never sleeps past the deadline: the last wait is the remainder.
    expect(sleeps).toEqual([10_000, 10_000, 5000]);
  });
});

describe("the deploy job runs it", () => {
  // A wait nothing invokes is the same failure as a wait that checks nothing,
  // and Deploy runs on no pull request — so this is the only thing that reads
  // the wiring before production does.
  test("before deploying, with node already set up", () => {
    const waitAt = deployWorkflow?.indexOf("node scripts/wait-for-npm-versions.mjs") ?? -1;
    expect(waitAt).toBeGreaterThan(-1);
    expect(waitAt).toBeGreaterThan(deployWorkflow?.indexOf("actions/setup-node@") ?? -1);
    expect(waitAt).toBeLessThan(deployWorkflow?.indexOf("modal deploy") ?? -1);
  });

  test("and no longer refuses the window it now waits out", () => {
    // The one-shot `curl` check this replaced. Left in place beside the wait, it
    // would fail every deploy the wait exists to carry through.
    expect(deployWorkflow).not.toContain("registry.npmjs.org/@alexkroman1%2f");
  });
});
