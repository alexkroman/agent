// Copyright 2025 the AAI authors. MIT license.
/**
 * Serving-path tests for the dev server, deliberately mock-free: the
 * existing _dev-server tests mock createServer/createRuntime/vite wholesale,
 * so nothing there would catch the real server failing to boot or serve.
 * (The heavier Vite/client path is exercised by e2e; the proxy wiring it
 * depends on is asserted below via `viteDevConfig`.)
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_LISTEN_HOST, WORKFLOW_API_PREFIX } from "@alexkroman1/aai-runtime";
import { WORKFLOW_DATA_DIR_ENV } from "@alexkroman1/aai-runtime/internal";
import getPort from "get-port";
import { describe, expect, test, vi } from "vitest";
import { agentEnvWarnings, startDevServer } from "./_dev-server.ts";
import { aaiRuntimeModule, WORKFLOW_DATA_DIR_ENV_LITERAL } from "./_dev-server-test-utils.ts";
import { viteDevConfig } from "./_dev-vite-config.ts";
import { linkSdkNodeModules, silenced, withTempDir } from "./_test-utils.ts";
import { DEDUPED_PEERS } from "./_vite-env.ts";

describe("agentEnvWarnings", () => {
  const DEFAULT_AGENT = {}; // no descriptors → default AssemblyAI pipeline → needs ASSEMBLYAI_API_KEY

  test("warns when a provider key is missing everywhere", () => {
    const warnings = agentEnvWarnings(DEFAULT_AGENT, {}, {});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Missing provider credential");
    expect(warnings[0]).toContain("ASSEMBLYAI_API_KEY");
  });

  test("warns about the deploy cliff when a key resolves from the shell only", () => {
    const warnings = agentEnvWarnings(DEFAULT_AGENT, {}, { ASSEMBLYAI_API_KEY: "sk-shell" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("resolved from your shell, not .env");
    expect(warnings[0]).toContain("ASSEMBLYAI_API_KEY");
    expect(warnings[0]).toContain("aai publish");
  });

  test("silent when the key is declared in .env", () => {
    expect(agentEnvWarnings(DEFAULT_AGENT, { ASSEMBLYAI_API_KEY: "sk-env" }, {})).toEqual([]);
  });

  test("a requiredEnv key is flagged even when the shell exports it", () => {
    const agent = { requiredEnv: ["STRIPE_KEY"] };
    const warnings = agentEnvWarnings(
      agent,
      { ASSEMBLYAI_API_KEY: "sk-env" },
      { STRIPE_KEY: "sk-shell" }, // custom keys never fall back to the shell
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("requiredEnv");
    expect(warnings[0]).toContain("STRIPE_KEY");
  });

  test("a requiredEnv key present in .env is silent", () => {
    const agent = { requiredEnv: ["STRIPE_KEY"] };
    const env = { ASSEMBLYAI_API_KEY: "sk-env", STRIPE_KEY: "sk-env" };
    expect(agentEnvWarnings(agent, env, {})).toEqual([]);
  });

  test("a workflow app with no credential anywhere warns about nothing", () => {
    // The `page` field has to be in the Pick, or a static agent is warned about
    // a key it never dials — and `resolveAgentEnv` reads the same list to decide
    // whether to reach for the logged-in key, so on that path the same omission
    // is a `not_logged_in` that stops `aai dev` from starting at all.
    expect(agentEnvWarnings({ page: "static" }, {}, {})).toEqual([]);
  });

  test("a workflow app is still told about its own requiredEnv keys", () => {
    // Suppressing the PROVIDER credential must not suppress the agent's own —
    // a workflow app reads `ctx.env` like any other.
    const warnings = agentEnvWarnings({ page: "static", requiredEnv: ["STRIPE_KEY"] }, {}, {});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("STRIPE_KEY");
  });
});

describe("viteDevConfig", () => {
  test("proxies /websocket with ws:true and /health to the backend", () => {
    const config = viteDevConfig("/proj", 3000, 3001);
    const proxy = config.server?.proxy as Record<string, unknown>;
    // Without ws:true the served client's WebSocket never connects.
    expect(proxy["/websocket"]).toEqual({ target: "http://127.0.0.1:3001", ws: true });
    expect(proxy["/health"]).toBe("http://127.0.0.1:3001");
  });

  test("proxies /client-config to the backend", () => {
    const config = viteDevConfig("/proj", 3000, 3001);
    const proxy = config.server?.proxy as Record<string, unknown>;
    // Without /client-config the default client can't learn the agent name.
    expect(proxy["/client-config"]).toBe("http://127.0.0.1:3001");
  });

  test("proxies the workflow API, the whole front door of a static app", () => {
    const config = viteDevConfig("/proj", 3000, 3001);
    const proxy = config.server?.proxy as Record<string, unknown>;
    // A `page: "static"` agent has no socket: `page()` renders a form and every
    // call it makes is a same-origin fetch under this prefix. Unproxied, Vite
    // answers its own 404 and submitting the form fails with `Workflow API 404`
    // while the backend serves the API correctly one port over.
    expect(proxy["/workflows"]).toMatchObject({ target: "http://127.0.0.1:3001" });
  });

  test("the workflow entry carries a bypass, so `workflows/` source is reachable", () => {
    // The prefix key also matches the project's own `workflows/` DIRECTORY,
    // which is where the SDK tells authors to put bodies — so a bare string
    // entry sent `client.tsx`'s import of `./workflows/stitch.ts` to the agent
    // server's 404 and rendered a blank page. This asserts only that the hook is
    // WIRED; what it decides needs a real Vite server and is asserted in
    // `dev-vite-workflow-proxy.scenario.test.ts`.
    const proxy = viteDevConfig("/proj", 3000, 3001).server?.proxy as Record<string, unknown>;
    const entry = proxy[WORKFLOW_API_PREFIX] as { bypass?: unknown };
    expect(typeof entry.bypass).toBe("function");
  });

  test("the workflow proxy key is the prefix the API is actually served under", () => {
    // Asserted against the SDK's own constant rather than restating "/workflows"
    // — a rename there would otherwise leave a proxy entry pointing at a path
    // nothing answers, which is the same silent failure by a new route.
    const proxy = viteDevConfig("/proj", 3000, 3001).server?.proxy as Record<string, unknown>;
    expect(Object.keys(proxy)).toContain(WORKFLOW_API_PREFIX);
  });

  test("the dev-server mocks spell the workflow data-dir key the way the SDK does", () => {
    // The sibling suites mock `@alexkroman1/aai-runtime/internal` wholesale, so
    // the key `startDevServer` writes the project's `.workflow-data` under comes
    // from a literal in their harness. This file mocks nothing, which makes it
    // the one place the two can be compared — and a disagreement is otherwise
    // silent in BOTH directions: the specs keep passing against their own
    // literal, and uploads land under a directory the reader never looks in.
    expect(WORKFLOW_DATA_DIR_ENV_LITERAL).toBe(WORKFLOW_DATA_DIR_ENV);
  });

  test("the dev-server mocks spell the runtime constants the way the SDK does", () => {
    // Same trap as the row above, one module over: the sibling suites mock
    // `@alexkroman1/aai-runtime` wholesale, so the proxy KEY and the BIND HOST
    // that `viteDevConfig` reads come from literals in that harness — a mock
    // may not import the module it mocks. A disagreement is silent in both
    // directions, and for `DEFAULT_LISTEN_HOST` it would be worse than for the
    // prefix: the specs would keep asserting `127.0.0.1` while the real config
    // handed Vite something else. This file mocks nothing, so it is the one
    // place the two can be compared.
    expect(aaiRuntimeModule()).toMatchObject({
      WORKFLOW_API_PREFIX,
      DEFAULT_LISTEN_HOST,
    });
  });

  test("every proxy target is an IP LITERAL, never a hostname", () => {
    // Vite opens a fresh upstream connection per WebSocket upgrade, so a hostname
    // here is one `getaddrinfo` per session handshake — on libuv's four-thread
    // pool, shared with the agent server in this same process. Measured with
    // `localhost`: one handshake in thirty stalled ~2s, concurrency 10 collapsed
    // to 0.6 rps at a 16.7s p50, and a sustained burst left the proxy refusing
    // upgrades until the dev server was restarted. With the literal: 260 rps at
    // a 166ms p99. Asserted over the WHOLE table so a route added later cannot
    // reintroduce it for itself.
    const proxy = viteDevConfig("/proj", 3000, 3001).server?.proxy as Record<string, unknown>;
    const targets = Object.values(proxy).map((entry) =>
      typeof entry === "string" ? entry : (entry as { target: string }).target,
    );
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) expect(new URL(target).hostname).toBe("127.0.0.1");
  });

  test("dedupes React, so a linked SDK does not render a blank page", () => {
    // aai-ui declares React as a peer; a project whose SDK is linked rather
    // than installed otherwise resolves aai-ui's own copy, and two Reacts turn
    // every hook in the page into "Invalid hook call" with a blank render.
    // `buildClient` has always deduped — this is the dev half of the same rule.
    expect(viteDevConfig("/proj", 3000, 3001).resolve?.dedupe).toEqual(DEDUPED_PEERS);
  });

  test("uses strictPort so the printed URL is never wrong", () => {
    // Vite would otherwise silently bind port+N when the port is busy while
    // executeDev prints/returns http://localhost:<requested port>.
    expect(viteDevConfig("/proj", 3000, 3001).server?.strictPort).toBe(true);
  });

  test("AAI_DEV_HOST binds Vite too, not just the backend", () => {
    // With a client.tsx, Vite owns the port the user is told to open — so a
    // backend bound to 0.0.0.0 behind a Vite bound to loopback is unreachable
    // from exactly the case the variable documents as its reason for existing
    // ("running `aai dev` inside a container and connecting from the host").
    vi.stubEnv("AAI_DEV_HOST", "0.0.0.0");
    expect(viteDevConfig("/proj", 3000, 3001).server?.host).toBe("0.0.0.0");
  });

  test.each(["", "   ", undefined])("binds the BACKEND's host for AAI_DEV_HOST=%o", (value) => {
    // `devBindHost` normalizes blank to "unset", and unset takes the same
    // constant `createServer` binds rather than Vite's own default. Vite's
    // default is the HOSTNAME `localhost`, so Node binds whatever
    // `getaddrinfo` answers first — measured `::1` on macOS, which makes
    // `http://127.0.0.1:<port>` ECONNREFUSED against a healthy server whose
    // URL `aai dev` prints as `http://localhost:<port>`. Asserted against the
    // runtime's own constant, so the two halves of `aai dev` cannot come to
    // name different loopbacks.
    vi.stubEnv("AAI_DEV_HOST", value);
    expect(viteDevConfig("/proj", 3000, 3001).server?.host).toBe(DEFAULT_LISTEN_HOST);
  });
});

describe("startDevServer (real serving path)", () => {
  test("boots a real agent dir and answers /health", { timeout: 30_000 }, async () => {
    await withTempDir(
      silenced(async (dir) => {
        await linkSdkNodeModules(dir);
        await writeFile(
          path.join(dir, "agent.ts"),
          `export default { name: "serve-test-agent", systemPrompt: "hi", tools: {} };`,
        );
        // A real key value is not needed — nothing connects until a session
        // starts — but its presence keeps resolveAgentEnv from prompting.
        await writeFile(path.join(dir, ".env"), "ASSEMBLYAI_API_KEY=test-key\n");

        const port = await getPort();
        const cleanup = await startDevServer({ cwd: dir, port });
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`);
          expect(res.ok).toBe(true);
          // Pre-connection client config: the agent's display name.
          const cfg = await fetch(`http://127.0.0.1:${port}/client-config`);
          expect(cfg.ok).toBe(true);
          expect(await cfg.json()).toMatchObject({
            name: "serve-test-agent",
          });
        } finally {
          await cleanup();
        }
      }),
    );
  });
});
