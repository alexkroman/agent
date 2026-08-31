// Copyright 2025 the AAI authors. MIT license.
/**
 * The studio page's CSP has to permit the ONE cross-origin thing the client
 * does: talk straight to the project's guest sandbox (chat + tool labels).
 * A `connect-src` that omits it fails in the browser as a bare
 * "Failed to fetch" with nothing at all on the server, so these tests tie
 * the policy to the URL `chatUrlForGuest` really produces for each
 * backend rather than to a hand-copied hostname literal.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import type { AppContext } from "aai-server/context";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatUrlForGuest } from "./studio-session-broker.ts";
import { studioCsp } from "./studio-static.ts";

/** The faked `aai-studio-client` package root the handler suite resolves to. */
const tmp = vi.hoisted(() => ({ dir: "" }));

// Only the module RESOLUTION is faked. The real cached reader still runs, so
// `clientDir()`'s own `dist` join and its containment check stay under test —
// faking the reader instead would leave the line that names the build
// directory unexercised.
vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  return {
    ...actual,
    createRequire: (url: string | URL) => {
      const req = actual.createRequire(url);
      return Object.assign(req.bind(null) as typeof req, req, {
        // Only the one-argument form is used by the module under test;
        // everything else delegates to the real resolver unchanged.
        resolve: ((id: string) =>
          id === "aai-studio-client/package.json"
            ? nodePath.join(tmp.dir, "package.json")
            : req.resolve(id)) as typeof req.resolve,
      });
    },
  };
});

/** The `connect-src` sources from a CSP string. */
function connectSrc(csp: string): string[] {
  const directive = csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("connect-src "));
  if (!directive) throw new Error(`no connect-src in: ${csp}`);
  return directive.slice("connect-src ".length).split(/\s+/);
}

/**
 * Approximates the browser's CSP host-source match for a cross-origin URL.
 * `'self'` never matches here — every URL under test is cross-origin by
 * construction (the sandbox is always a different origin than the studio).
 */
function allowsOrigin(csp: string, url: string): boolean {
  const target = new URL(url);
  return connectSrc(csp).some((source) => {
    const m = /^(https?):\/\/(\*\.)?([^:/]+)(?::(\*|\d+))?$/.exec(source);
    if (!m) return false;
    const [, scheme, wildcard, host, port] = m;
    if (`${scheme}:` !== target.protocol) return false;
    if (wildcard ? !target.hostname.endsWith(`.${host}`) : target.hostname !== host) return false;
    return !port || port === "*" || port === target.port;
  });
}

describe("studioCsp", () => {
  it("keeps the restrictive baseline", () => {
    const csp = studioCsp({ SANDBOX_BACKEND: "modal" });
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-src 'self'");
    expect(csp).toContain("font-src 'self'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    // The tail directives sit in their own concatenated string, so they are
    // the part a rewrite drops without touching anything asserted above.
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(connectSrc(csp)).toContain("'self'");
  });

  it("permits the Modal sandbox chat origin in production", () => {
    const csp = studioCsp({ SANDBOX_BACKEND: "modal" });
    const chatUrl = chatUrlForGuest("wss://ab12cd-8080.modal.host:443");
    expect(allowsOrigin(csp, chatUrl)).toBe(true);
  });

  it("permits the loopback sandbox chat origin under subprocess", () => {
    const csp = studioCsp({ SANDBOX_BACKEND: "subprocess" });
    const chatUrl = chatUrlForGuest("ws://127.0.0.1:55251");
    expect(allowsOrigin(csp, chatUrl)).toBe(true);
  });

  it("does not permit loopback origins in production", () => {
    const csp = studioCsp({ SANDBOX_BACKEND: "modal" });
    expect(allowsOrigin(csp, "http://127.0.0.1:55251/studio/chat")).toBe(false);
  });

  // `it.each`, not a `for…of`: the loop reported one failure for both
  // backends and named neither, so a policy that leaked only under
  // `subprocess` read as "does not permit arbitrary third-party origins".
  it.each(["modal", "subprocess"])(
    "does not permit arbitrary third-party origins under %s",
    (backend) => {
      const csp = studioCsp({ SANDBOX_BACKEND: backend });
      expect(allowsOrigin(csp, "https://evil.example.com/studio/chat")).toBe(false);
    },
  );

  // The sign-in leg: supabase-js dials the project origin from the page (the
  // OAuth code/token exchange when the GitHub redirect lands), so a
  // connect-src without it fails as the same bare "Failed to fetch" — with
  // nothing on the server, since no request is ever sent.
  describe("Supabase sign-in origin", () => {
    const supabaseAuth = {
      mode: "supabase",
      supabaseUrl: "https://abc123.supabase.co",
      supabasePublishableKey: "sb_publishable_test",
    } as const;
    const tokenUrl = `${supabaseAuth.supabaseUrl}/auth/v1/token`;

    it("permits the configured project's auth endpoints", () => {
      const csp = studioCsp({ SANDBOX_BACKEND: "modal" }, supabaseAuth);
      expect(allowsOrigin(csp, tokenUrl)).toBe(true);
    });

    it("permits only that project, not every Supabase project", () => {
      const csp = studioCsp({ SANDBOX_BACKEND: "modal" }, supabaseAuth);
      expect(allowsOrigin(csp, "https://someoneelse.supabase.co/auth/v1/token")).toBe(false);
    });

    it("tolerates a trailing slash on the configured URL", () => {
      const csp = studioCsp(
        { SANDBOX_BACKEND: "modal" },
        { ...supabaseAuth, supabaseUrl: "https://abc123.supabase.co/" },
      );
      expect(allowsOrigin(csp, tokenUrl)).toBe(true);
    });

    it("adds no source for dev auth or an unconfigured login", () => {
      const dev = connectSrc(studioCsp({ SANDBOX_BACKEND: "subprocess" }, { mode: "dev" }));
      expect(dev).toEqual(connectSrc(studioCsp({ SANDBOX_BACKEND: "subprocess" })));
      // Exact list, not a substring check: the point is that dev auth
      // contributes NOTHING, and any extra source would still satisfy a
      // "does not mention supabase" assertion.
      expect(dev).toEqual(["'self'", "http://127.0.0.1:*"]);
    });

    it("throws on an unparsable URL rather than silently omitting it", () => {
      expect(() =>
        studioCsp({ SANDBOX_BACKEND: "modal" }, { ...supabaseAuth, supabaseUrl: "abc123" }),
      ).toThrow(/SUPABASE_URL/);
    });

    it("keeps the underlying parse failure as the cause", () => {
      // The message names the setting; the cause is what says why it failed.
      let caught: unknown;
      try {
        studioCsp({ SANDBOX_BACKEND: "modal" }, { ...supabaseAuth, supabaseUrl: "abc123" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).cause).toBeInstanceOf(Error);
    });
  });
});

/**
 * The three handlers themselves, driven over a real Hono app against a real
 * (temporary) build directory. Only the module resolution is faked, so
 * `clientDir()`'s own `dist` join, the containment check, and the cached
 * reader all stay under test — mocking the reader instead would have left the
 * one line that names the build directory unexercised.
 */
describe("studio client handlers", () => {
  beforeEach(async () => {
    tmp.dir = await mkdtemp(nodePath.join(tmpdir(), "aai-studio-static-"));
    await writeFile(nodePath.join(tmp.dir, "package.json"), '{"name":"aai-studio-client"}');
    // Module-level memos (client dir, CSP headers, decoded shell, read cache)
    // outlive a single test, so each case gets a fresh module instance.
    vi.resetModules();
  });

  afterEach(async () => {
    await rm(tmp.dir, { recursive: true, force: true });
  });

  /** Write `rel` into the faked build output. */
  async function build(rel: string, content: string | Buffer) {
    const full = nodePath.join(tmp.dir, "dist", rel);
    await mkdir(nodePath.dirname(full), { recursive: true });
    await writeFile(full, content);
  }

  const BINDINGS = { auth: undefined } as unknown as AppContext["env"];

  /**
   * Hono hands the route callback its own context type; the handlers take the
   * app's `AppContext`. Narrow at this one seam rather than per route; the
   * escape-hatch ratchet counts every occurrence.
   */
  const asAppContext = (c: object): AppContext => c as unknown as AppContext;

  /**
   * A Hono app wired to the freshly imported handlers.
   *
   * `draining` is a per-app switch rather than a module one so the same import
   * can serve both the steady-state 404 and the drain-time 503.
   */
  async function app({ draining = false }: { draining?: boolean } = {}) {
    const { handleStudioPage, handleStudioFavicon, studioClientAssetHandler } = await import(
      "./studio-static.ts"
    );
    const asset = studioClientAssetHandler(() => draining);
    const hono = new Hono();
    hono.get("/", (c) => handleStudioPage(asAppContext(c)));
    hono.get("/favicon.ico", (c) => handleStudioFavicon(asAppContext(c)));
    hono.get("/studio-assets/:path{.+}", (c) => asset(asAppContext(c)));
    // Same handler with no `path` param — the shape a route change could
    // produce, where the handler must refuse rather than read something.
    hono.get("/unparameterized", (c) => asset(asAppContext(c)));
    return {
      get: (url: string) => hono.fetch(new Request(`http://studio.test${url}`), BINDINGS),
    };
  }

  describe("GET / (app shell)", () => {
    it("serves the built index.html with the studio CSP", async () => {
      await build("index.html", "<!doctype html><title>built shell</title>");
      const res = await (await app()).get("/");

      expect(res.status).toBe(200);
      expect(await res.text()).toContain("built shell");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    });

    // The shell names content-hashed assets that live only in the image it
    // was built into, and those are served `immutable`. Cached, it pins a
    // browser to a build whose `/studio-assets/*` 404 the moment a Modal
    // deploy retires that image — a white page with no JS left to recover.
    it("is never cached, unlike the assets it names", async () => {
      await build("index.html", "<!doctype html><title>built shell</title>");
      const res = await (await app()).get("/");

      expect(res.headers.get("cache-control")).toBe("no-store");
    });

    it("is uncacheable on the not-built fallback too", async () => {
      // Same reasoning, and the path a partially-built server actually
      // serves — caching "not built" outlasts the build that fixes it.
      const res = await (await app()).get("/");

      expect(res.headers.get("cache-control")).toBe("no-store");
    });

    it("serves the same shell on a repeat request", async () => {
      // The decoded shell is cached by buffer identity; a second request must
      // still get the page rather than a stale or empty body.
      await build("index.html", "<!doctype html><title>built shell</title>");
      const client = await app();

      expect(await (await client.get("/")).text()).toContain("built shell");
      expect(await (await client.get("/")).text()).toContain("built shell");
    });

    it("explains how to build when the client is missing", async () => {
      const res = await (await app()).get("/");

      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("has not been built");
      expect(body).toContain("pnpm --filter aai-studio-client build");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    });

    it("reads the shell from dist, not the package root", async () => {
      // A build output resolved one directory too high would serve the
      // package's own files as the app shell.
      await writeFile(nodePath.join(tmp.dir, "index.html"), "<title>package root</title>");
      const body = await (await (await app()).get("/")).text();

      expect(body).not.toContain("package root");
      expect(body).toContain("has not been built");
    });
  });

  describe("GET /favicon.ico", () => {
    it("serves the icon with a day-long cache", async () => {
      await build("favicon.ico", Buffer.from([0, 0, 1, 0]));
      const res = await (await app()).get("/favicon.ico");

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/x-icon");
      expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0, 0, 1, 0]));
    });

    it("404s when the client has not been built", async () => {
      const res = await (await app()).get("/favicon.ico");

      expect(res.status).toBe(404);
      expect(await res.text()).toContain("Favicon not found");
    });
  });

  describe("GET /studio-assets/*", () => {
    it("serves a hashed asset as immutable", async () => {
      await build("assets/app-a1b2c3.js", "console.log(1)");
      const res = await (await app()).get("/studio-assets/assets/app-a1b2c3.js");

      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(res.headers.get("content-type")).toContain("javascript");
      expect(await res.text()).toBe("console.log(1)");
    });

    it("falls back to a binary content type for an unknown extension", async () => {
      await build("assets/data.unknownext", "blob");
      const res = await (await app()).get("/studio-assets/assets/data.unknownext");

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/octet-stream");
    });

    it("rejects a traversing path", async () => {
      // The separator is percent-encoded, not the dots: the URL parser
      // resolves real `../` segments away before routing, so an encoded slash
      // is what carries a traversal all the way to the schema.
      const res = await (await app()).get("/studio-assets/..%2fpackage.json");

      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Invalid asset path");
    });

    it("rejects a backslash path", async () => {
      const res = await (await app()).get("/studio-assets/..%5cpackage.json");

      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Invalid asset path");
    });

    it("refuses a request carrying no path at all", async () => {
      // Falls back to the empty path, which the schema rejects — the fallback
      // must not be something the reader would go looking for.
      await build("index.html", "<title>shell</title>");
      const res = await (await app()).get("/unparameterized");

      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Invalid asset path");
    });

    it("404s an asset that is not in the build", async () => {
      await build("assets/app.js", "console.log(1)");
      const res = await (await app()).get("/studio-assets/assets/missing.js");

      expect(res.status).toBe(404);
      expect(await res.text()).toContain("Asset not found");
    });

    /**
     * The cross-build request a rolling deploy makes unavoidable: the shell
     * comes from the new replica and its entry script lands on this one, which
     * is on its way out. Production answered that 404 (and served the same URL
     * 200 forty-one seconds later), which is false twice over and cacheable by
     * an intermediary — see the handler's own doc.
     */
    it("503s a missing asset while draining, and forbids caching it", async () => {
      await build("assets/app.js", "console.log(1)");
      const res = await (await app({ draining: true })).get("/studio-assets/assets/missing.js");

      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("1");
      expect(res.headers.get("cache-control")).toBe("no-store");
    });

    it("still 404s a missing asset when NOT draining", async () => {
      // The gate is the drain flag, not the path's shape: answering 503 to an
      // asset that genuinely does not exist would say "retry" forever.
      await build("assets/app.js", "console.log(1)");
      const res = await (await app({ draining: false })).get("/studio-assets/assets/missing.js");

      expect(res.status).toBe(404);
    });

    it("serves a present asset normally while draining", async () => {
      // Draining changes the answer for a MISSING asset only — this replica is
      // still serving, and its own build is still correct.
      await build("assets/app-a1b2c3.js", "console.log(1)");
      const res = await (await app({ draining: true })).get("/studio-assets/assets/app-a1b2c3.js");

      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toContain("immutable");
    });
  });
});
