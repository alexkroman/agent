// Copyright 2026 the AAI authors. MIT license.
/**
 * Tests for the shared guest-harness wiring: stdio draining (log cap
 * included) and the guest WebSocket dial against a real loopback server.
 * The WarmHarness lifecycle itself (exit fan-out, memoized cleanup) is
 * exercised through both backends' suites — modal-sandbox.test.ts and
 * subprocess-sandbox.test.ts.
 */

import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { raceGuestExit } from "./guest-readiness.ts";
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
    // Reserve a port, dial it while nothing is listening, then bring the
    // server up mid-retry — the dial must recover, not fail fast.
    const probe = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((resolve) => probe.once("listening", resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((resolve) => probe.close(resolve));

    const pending = dialGuest(`ws://127.0.0.1:${port}/ws`, "tok");
    await new Promise((resolve) => setTimeout(resolve, 150));
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
    token: "tok",
    port: 8080,
    bundlePath: "/b/bundle.mjs",
    bundleSha256: "abc",
    envPath: "/b/env.json",
  };

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
});

/**
 * Every way a guest fails to come up exits the process, with the reason on
 * its stderr. Without this race a readiness wait burns its whole budget and
 * then blames the network for what the guest already explained.
 */
describe("raceGuestExit", () => {
  const stream = (): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(c) {
        c.close();
      },
    });

  const procThat = (wait: () => Promise<number>) => ({
    stdout: stream(),
    stderr: stream(),
    wait,
  });

  it("resolves with the work when the guest stays up", async () => {
    const proc = procThat(() => new Promise<number>(() => undefined));
    await expect(raceGuestExit(Promise.resolve("ready"), proc)).resolves.toBe("ready");
  });

  it("fails with the exit code when the guest dies first", async () => {
    const proc = procThat(() => Promise.resolve(3));
    await expect(raceGuestExit(new Promise<void>(() => undefined), proc)).rejects.toThrow(
      /guest exited before ready \(exit 3\)/,
    );
  });

  it("reports a rejected wait as an exit rather than hanging", async () => {
    const proc = procThat(() => Promise.reject(new Error("gone")));
    await expect(raceGuestExit(new Promise<void>(() => undefined), proc)).rejects.toThrow(
      /guest exited before ready \(exit -1\)/,
    );
  });

  it("propagates the work's own failure untouched", async () => {
    const proc = procThat(() => new Promise<number>(() => undefined));
    await expect(raceGuestExit(Promise.reject(new Error("probe timeout")), proc)).rejects.toThrow(
      "probe timeout",
    );
  });

  // The losing branch settles after the race is decided; an unhandled
  // rejection there would take down the process under Node's default.
  it("contains a work rejection that lands after the exit", async () => {
    let failWork: (err: Error) => void = () => undefined;
    const work = new Promise<void>((_resolve, reject) => {
      failWork = reject;
    });
    const proc = procThat(() => Promise.resolve(1));
    await expect(raceGuestExit(work, proc)).rejects.toThrow(/exit 1/);
    failWork(new Error("late"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
