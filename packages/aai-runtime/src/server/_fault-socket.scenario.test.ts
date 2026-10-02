// Copyright 2026 the AAI authors. MIT license.
/**
 * The severing TCP proxy on its own terms: what it counts as a sever, and that
 * each `severAfter` trigger fires on its own — the fault injector's oracle,
 * which `session-resume.scenario.test.ts` and
 * `session-resume-state.scenario.test.ts` rest on. Scenario tier: real
 * loopback ports.
 */

import { sleep } from "@alexkroman1/aai/internal";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { silentLogger } from "../_logger-test-utils.ts";
import { createSeveringProxy, type SeveringProxy } from "./_fault-socket.ts";
import { createServerForRuntime } from "./server.ts";

/** The one frame the server answers every connection with. */
type ConfigFrame = { type: "config"; sessionId: string };

let harness: { proxy: SeveringProxy; close: () => Promise<void> } | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** A server whose runtime answers each socket with a `config` frame, behind a proxy. */
async function serve(): Promise<{ proxy: SeveringProxy; close: () => Promise<void> }> {
  let minted = 0;
  const server = createServerForRuntime({
    runtime: {
      startSession(ws) {
        minted += 1;
        ws.send(JSON.stringify({ type: "config", sessionId: `sess_${minted}` }));
      },
      shutdown: () => Promise.resolve(),
    },
    logger: silentLogger,
  });
  await server.listen(0, "127.0.0.1");
  if (server.port === undefined) throw new Error("server did not report a port");
  const proxy = await createSeveringProxy({ target: server.port });
  return {
    proxy,
    close: async () => {
      await proxy.close();
      await server.close();
    },
  };
}

/** Connect through `proxy` and resolve the `config` frame the server answers with. */
async function connect(proxy: SeveringProxy): Promise<{ ws: WebSocket; config: ConfigFrame }> {
  const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/websocket`);
  const config = await new Promise<ConfigFrame>((resolve, reject) => {
    ws.once("message", (data: Buffer) => resolve(JSON.parse(data.toString("utf8")) as ConfigFrame));
    ws.once("error", reject);
    ws.once("close", () => reject(new Error("closed before the config frame")));
  });
  return { ws, config };
}

/** The close code a client observes, which is the evidence the drop was ABRUPT. */
function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once("close", (code: number) => resolve(code)));
}

describe("createSeveringProxy", () => {
  test("a clean client close is NOT counted as a sever", async () => {
    // The proxy's own oracle: if a normal hangup incremented the counter, a suite
    // running under this mode could not tell an injected fault from a client
    // going away, and "did it inject anything" would be unanswerable.
    harness = await serve();
    const { ws } = await connect(harness.proxy);
    const closed = closeCode(ws);
    ws.close();
    await closed;
    expect(harness.proxy.severed()).toBe(0);
    expect(harness.proxy.live()).toBe(0);
  });

  test("severAfter.bytesFromClient cuts on its own, with no test involvement", async () => {
    // The suite-wide shape: a connection that severs itself once the client has
    // sent a given number of bytes. Deterministic, so the Nth connection is cut at
    // the same point on every machine — the same rule the restart mode follows.
    harness = await serve();
    const proxy = await createSeveringProxy({
      target: harness.proxy.port,
      severAfter: { bytesFromClient: 1 },
    });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/websocket`);
      // The handshake itself is bytes from the client, so this severs during it.
      await new Promise<void>((resolve) => {
        ws.once("close", () => resolve());
        ws.once("error", () => resolve());
      });
      expect(proxy.severed()).toBe(1);
    } finally {
      await proxy.close();
    }
  });

  test("severAfter.ms cuts an ESTABLISHED session, which a byte budget cannot", async () => {
    // This is what the `ms` trigger is FOR, and why it is not redundant with the
    // budget above: a byte budget small enough to fire reliably cuts during the
    // handshake (the test above never completes an upgrade), and one large enough
    // to clear it depends on the audio rate, so "cut a session that is already
    // running" is only expressible in time. `severAll()` covers the case where a
    // test picks the moment; this covers a profile running unattended.
    //
    // It also had NO test until this one, which is the worst gap available in a
    // fault injector: a trigger that silently never fires makes a suite report
    // that it ran under faults having injected none.
    harness = await serve();
    const proxy = await createSeveringProxy({
      target: harness.proxy.port,
      severAfter: { ms: 200 },
    });
    try {
      // Establishing first is the point — the config frame proves the session is
      // up, so what gets cut is a live session rather than a handshake.
      const { ws, config } = await connect(proxy);
      expect(config.sessionId).toBeTruthy();
      const code = await closeCode(ws);
      expect(code).toBe(1006);
      expect(proxy.severed()).toBe(1);
    } finally {
      await proxy.close();
    }
  });

  test("a proxy with NO severAfter leaves an established session alone", async () => {
    // The control for the test above. Without it, a connection dropped for any
    // other reason — the upstream closing, a relay bug — would read as the timer
    // working, and the `ms` trigger could be removed with both tests still green.
    harness = await serve();
    const proxy = await createSeveringProxy({ target: harness.proxy.port });
    try {
      const { ws } = await connect(proxy);
      await sleep(400);
      expect(proxy.severed()).toBe(0);
      expect(proxy.live()).toBe(1);
      ws.close();
    } finally {
      await proxy.close();
    }
  });
});
