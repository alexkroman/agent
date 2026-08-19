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
  it("logs guest output under the label and skips blank chunks", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await drainProcStream(streamOf(["boom at line 3\n", "   \n"]), "[container:x] stderr");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[container:x] stderr: boom at line 3");
  });

  it("stops logging past the byte cap but keeps draining to stream end", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const big = "x".repeat(64 * 1024); // one chunk exhausts the cap
    await expect(drainProcStream(streamOf([big, "after the cap"]), "[l]")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1); // the capped chunk only
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
    // Retention needs a DECLARED local run; an empty env is production, where
    // nothing is remembered on purpose.
    rememberPublicOrigin(new Request("https://agents.test/digest-desk/client-config"), {
      AAI_LOCAL_DEV: "1",
    });
    expect(agentBootEnv(boot, {})).toMatchObject({
      AAI_PUBLIC_BASE_URL: "https://agents.test/digest-desk",
    });
  });
});
