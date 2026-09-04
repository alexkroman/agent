// Copyright 2026 the AAI authors. MIT license.
/**
 * Tests for the shared guest-harness wiring: stdio draining (log cap
 * included) and the guest WebSocket dial against a real loopback server.
 * The WarmHarness lifecycle itself (exit fan-out, memoized cleanup) is
 * exercised through both backends' suites — modal-sandbox.test.ts and
 * subprocess-sandbox.test.ts.
 */

import net, { type AddressInfo } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { forgetObservedPublicOrigin, rememberPublicOrigin } from "./public-origin.ts";
import { captureLogs } from "./test-utils.ts";
import { agentBootEnv, dialGuest, drainProcStream } from "./warm-harness.ts";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(encoder.encode(chunk));
      c.close();
    },
  });
}

describe("drainProcStream", () => {
  const logs = captureLogs();
  it("logs guest output under the label and skips blank chunks", async () => {
    await drainProcStream(streamOf(["boom at line 3\n", "   \n"]), "[container:x] stderr");
    expect(logs.warns()).toEqual(["guest [container:x] stderr: boom at line 3"]);
  });

  it("stops logging past the byte cap but keeps draining to stream end", async () => {
    const big = "x".repeat(64 * 1024); // one chunk exhausts the cap
    await expect(drainProcStream(streamOf([big, "after the cap"]), "[l]")).resolves.toBeUndefined();
    expect(logs.warns()).toHaveLength(1); // the capped chunk only
  });

  it("swallows a stream that errors mid-read", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.error(new Error("peer died"));
      },
    });
    await expect(drainProcStream(stream, "[l]")).resolves.toBeUndefined();
  });
});

describe("dialGuest", () => {
  it("connects to a listening harness and presents the bearer token", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((resolve) => wss.once("listening", resolve));
    const port = (wss.address() as AddressInfo).port;
    const authHeader = new Promise<string | undefined>((resolve) => {
      wss.once("connection", (_ws, req) => resolve(req.headers.authorization));
    });

    const ws = await dialGuest(`ws://127.0.0.1:${port}/ws`, "tok-123");
    try {
      await expect(authHeader).resolves.toBe("Bearer tok-123");
      expect(ws.readyState).toBe(ws.OPEN);
    } finally {
      ws.close();
      await new Promise((resolve) => wss.close(resolve));
    }
  });

  it("retries refused connections until the harness server comes up", async () => {
    // A plain TCP server HOLDS the port and hangs up on every connection, so
    // the dial fails its handshake the way a not-yet-listening harness makes
    // it fail — then the real server takes the port over. Two things this buys
    // over the reserve-close-sleep shape it replaces: the failed attempt is
    // COUNTED rather than assumed to have happened inside a 150ms wall-clock
    // wait, and the port is never unowned in between, so no other process on
    // the machine can win the re-bind and turn this into a flake.
    let refused = 0;
    const holder = net.createServer((socket) => {
      refused += 1;
      socket.destroy();
    });
    await new Promise((resolve) => holder.listen(0, "127.0.0.1", () => resolve(undefined)));
    const port = (holder.address() as AddressInfo).port;

    const pending = dialGuest(`ws://127.0.0.1:${port}/ws`, "tok");
    await vi.waitFor(() => expect(refused).toBeGreaterThan(0));
    await new Promise((resolve) => holder.close(resolve));

    const wss = new WebSocketServer({ host: "127.0.0.1", port });
    await new Promise((resolve) => wss.once("listening", resolve));

    const ws = await pending;
    try {
      expect(ws.readyState).toBe(ws.OPEN);
    } finally {
      ws.close();
      await new Promise((resolve) => wss.close(resolve));
    }
  });
});

describe("agentBootEnv", () => {
  const boot = {
    slug: "digest-desk",
    token: "tok",
    port: 8080,
    bundle: { path: "/b/bundle.mjs" },
    bundleSha256: "abc",
    envPath: "/b/env.json",
  };

  // The observed origin is module state on `public-origin.ts` and outlives
  // `restoreMocks`, so a spec asserting the UNOBSERVED case has to get back to
  // it — and one that did not clear it would pass on whatever an earlier file
  // happened to leave behind.
  beforeEach(() => {
    forgetObservedPublicOrigin();
  });

  it("names the boot artifacts the guest reads", () => {
    expect(agentBootEnv(boot, {})).toEqual({
      AAI_GUEST_MODE: "agent",
      AAI_GUEST_TOKEN: "tok",
      AAI_GUEST_PORT: "8080",
      AAI_BUNDLE_PATH: "/b/bundle.mjs",
      AAI_BUNDLE_SHA256: "abc",
      AAI_AGENT_ENV_PATH: "/b/env.json",
    });
  });

  /**
   * `TMPDIR` is a property of the CONTAINER, not of agent mode, and this is what
   * keeps it from coming back here.
   *
   * It used to be built here — with a `scratchDir` option whose one non-default
   * caller was `subprocess`, passing `null` to opt OUT — because
   * `guestExecBaseEnv()`, where a contained guest's ambient keys belong, was one
   * line from its file's length cap. The cost was three copies of one value: this
   * one plus both studio spawn sites. It is `guest-exec-env.ts` now, spread by the
   * four contained exec sites and by no other, so this env is `AAI_*` boot
   * parameters and nothing else. `guest-exec-env.test.ts` owns the other half.
   */
  it("names no TMPDIR: a scratch directory is the container's, not the mode's", () => {
    expect(agentBootEnv(boot, {})).not.toHaveProperty("TMPDIR");
  });

  // The two bundle shapes are mutually exclusive on the wire, not merely
  // preferred one over the other: a guest handed both a path that was never
  // written and a URL would have a precedence rule to get wrong, and a v1
  // harness reading the dead path would boot nothing at all.
  it("names the bundle URL instead of a path when the guest fetches its own", () => {
    const env = agentBootEnv({ ...boot, bundle: { url: "https://blobs.test/signed" } }, {});
    expect(env.AAI_BUNDLE_URL).toBe("https://blobs.test/signed");
    expect(env).not.toHaveProperty("AAI_BUNDLE_PATH");
    // The hash rides along either way — it is what makes the URL safe.
    expect(env.AAI_BUNDLE_SHA256).toBe("abc");
  });

  // Span export is armed by an ENDPOINT, so every other OTel key is dead
  // weight without one — and a key that is present and useless is the shape a
  // misconfiguration takes (the reason the three URL keys are omitted rather
  // than set blank).
  it("forwards the collector configuration only when an endpoint names one", () => {
    expect(agentBootEnv(boot, { OTEL_SERVICE_NAME: "agent-eu" })).not.toHaveProperty(
      "OTEL_SERVICE_NAME",
    );
    expect(
      agentBootEnv(boot, {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
        OTEL_EXPORTER_OTLP_HEADERS: "api-key=secret",
        OTEL_SERVICE_NAME: "agent-eu",
      }),
    ).toMatchObject({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      OTEL_EXPORTER_OTLP_HEADERS: "api-key=secret",
      OTEL_SERVICE_NAME: "agent-eu",
    });
  });

  // The signal-specific endpoint arms it on its own: an operator who points
  // only traces at a collector must not get a guest that exports nothing.
  it("is armed by the traces-specific endpoint too", () => {
    expect(
      agentBootEnv(boot, { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://c:4318/v1/traces" }),
    ).toMatchObject({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://c:4318/v1/traces" });
  });

  // The pairing with the guest's own reader is asserted only by these literals
  // and its own, because this package may not import guest source — the
  // boundary `konsistent` enforces. That is a weaker guarantee than the two
  // lists compared against each other, and it is acceptable HERE only because
  // the names are OpenTelemetry's rather than ours: neither side is free to
  // rename one. A key of our own spelling crossing this hop would owe the
  // text-scan treatment `guard-invariants` rule 12 gives `GUEST_ROUTES`.

  // The guest documents AAI_GUEST_IDLE_EXIT_MS as its idle-exit override, but
  // reads it from `process.env` — and only Modal guests have an ambient
  // environment to read. The subprocess backend builds a minimal env by
  // design, so the knob did nothing there until the spawner forwarded it.
  it("forwards the guest idle-exit override from the server's env", () => {
    expect(agentBootEnv(boot, { AAI_GUEST_IDLE_EXIT_MS: "15000" })).toMatchObject({
      AAI_GUEST_IDLE_EXIT_MS: "15000",
    });
  });

  it("omits the override when unset or blank, leaving the guest's default", () => {
    expect(agentBootEnv(boot, {})).not.toHaveProperty("AAI_GUEST_IDLE_EXIT_MS");
    expect(agentBootEnv(boot, { AAI_GUEST_IDLE_EXIT_MS: "  " })).not.toHaveProperty(
      "AAI_GUEST_IDLE_EXIT_MS",
    );
  });

  /**
   * The flag an operator has to be able to set, and could not.
   *
   * `debugLoggingEnabled` (aai-runtime/runtime-config.ts) is a module-level
   * `const` over `process.env`, and a deployed agent's env arrives as a boot FILE
   * the harness parses into an object — never merged into `process.env`. So the
   * one line that decomposes the guest→platform journal RPC
   * (`platform-rpc.ts`'s `{ label, route, traceId, status, elapsedMs }`) was
   * unreachable in every deployed guest, which is the only place that RPC exists.
   * Forwarding it explicitly keeps the minimal-env property: the guest inherits
   * nothing, and this is one more declared `AAI_*` boot parameter.
   */
  it("forwards the debug-logging flag from the server's env", () => {
    expect(agentBootEnv(boot, { AAI_DEBUG: "1" })).toMatchObject({ AAI_DEBUG: "1" });
  });

  // Off unless the operator says so — and blank is not saying so, same trim as the
  // idle-exit override beside it. The minimal env is the whole reason this file
  // exists, so a key that appears when nothing asked for it is the regression.
  it("omits the debug flag when the server's env does not set it", () => {
    expect(agentBootEnv(boot, {})).not.toHaveProperty("AAI_DEBUG");
    expect(agentBootEnv(boot, { AAI_DEBUG: "  " })).not.toHaveProperty("AAI_DEBUG");
  });

  /**
   * Two spellings NOT forwarded, both deliberately.
   *
   * `debugLoggingEnabled` also accepts `LOG_LEVEL=DEBUG`, but `LOG_LEVEL` is a
   * generic name a hosting stack sets for its own reasons — forwarding it would
   * make the PLATFORM's own log level arm per-message logging inside a tenant's
   * guest as a side effect, and every other key in this env is `AAI_*` by rule.
   * `AAI_DEBUG_PARTIALS` is a second, much louder flag (one line per ~200 ms of
   * speech) that the runtime leaves off even under `AAI_DEBUG=1` precisely so the
   * turn-level lines stay readable; it says nothing about a platform round trip.
   * Its absence is a decision, not an oversight — and one line to reverse.
   */
  it("forwards neither LOG_LEVEL nor the partials flag", () => {
    const env = agentBootEnv(boot, { LOG_LEVEL: "DEBUG", AAI_DEBUG_PARTIALS: "1" });
    expect(env).not.toHaveProperty("LOG_LEVEL");
    expect(env).not.toHaveProperty("AAI_DEBUG_PARTIALS");
    // And neither one arms the flag by another route.
    expect(env).not.toHaveProperty("AAI_DEBUG");
  });

  // The one key whose consumer is the BUNDLE's SDK rather than the harness: it
  // becomes `createRuntime`'s `publicUrl`, and `ctx.workflows.publicWebhookUrl`
  // is what reads it. The slug is part of the value because the platform serves
  // every agent under `/:slug`.
  it("carries the agent's public base URL, origin plus slug", () => {
    expect(agentBootEnv(boot, { AAI_PUBLIC_ORIGIN: "https://aai.example" })).toMatchObject({
      AAI_PUBLIC_BASE_URL: "https://aai.example/digest-desk",
    });
  });

  // The SAME value under a second name, and the duplication is load-bearing: this one
  // claims "the thing at this URL serves my upload bytes", which only a managed
  // platform can say, while `AAI_PUBLIC_BASE_URL` answers "where do third parties reach
  // me" — a question a self-hosted deployment behind a proxy also answers. One key for
  // both would put such an agent on a byte route nothing serves and 404 every upload.
  it("names the upload broker separately, at the same URL", () => {
    expect(agentBootEnv(boot, { AAI_PUBLIC_ORIGIN: "https://aai.example" })).toMatchObject({
      AAI_UPLOAD_BROKER_URL: "https://aai.example/digest-desk",
    });
  });

  // Omitted rather than empty: a present-and-useless key is the shape a
  // `publicUrl: ""` bug takes, and minting `/.well-known/…` — a relative URL
  // nothing can call back on — is worse than throwing. Both keys, because a broker URL
  // this replica cannot name is a byte route the guest would dial at `/uploads/…`.
  it("omits both URLs when this replica can name no origin", () => {
    expect(agentBootEnv(boot, {})).not.toHaveProperty("AAI_PUBLIC_BASE_URL");
    expect(agentBootEnv(boot, {})).not.toHaveProperty("AAI_UPLOAD_BROKER_URL");
  });

  // No request reaches a wake sweep or a blue-green handover, so the observed
  // origin is what those spawns have; this is the path that makes the feature
  // work on a deployment that never set AAI_PUBLIC_ORIGIN.
  it("falls back to the origin a request was last served on", () => {
    // Retention needs a DECLARED local run AND a loopback Host — an empty env is
    // production, where nothing is remembered on purpose, and even a local run
    // learns only from a host that names this server (`rememberPublicOrigin`).
    rememberPublicOrigin(new Request("http://localhost:8080/digest-desk/client-config"), {
      AAI_LOCAL_DEV: "1",
    });
    expect(agentBootEnv(boot, {})).toMatchObject({
      AAI_PUBLIC_BASE_URL: "http://localhost:8080/digest-desk",
    });
  });
});
