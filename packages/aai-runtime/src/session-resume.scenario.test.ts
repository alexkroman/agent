// Copyright 2026 the AAI authors. MIT license.
/**
 * A session survives a severed connection — the disconnect contract, over a real
 * socket that is really cut.
 *
 * Scenario tier because the whole point is that nothing here is simulated: a
 * real `createRuntimeServer`, a real WebSocket upgrade, a real TCP relay, and a
 * `destroy()` that produces the abrupt drop a load-balancer timeout or a changed
 * network produces. A test that called `ws.close()` would prove the opposite of
 * what it looks like it proves — a clean close is the "user hung up" case, which
 * the client is documented NOT to reconnect from.
 *
 * ## What this proves, and what it stands in for
 *
 * The RUNTIME is a double, and deliberately: resolving real providers to open a
 * session would mean credentials and a live STT socket, and none of that is what
 * a disconnect threatens. What a disconnect threatens is session IDENTITY — that
 * the reconnect lands on the same session rather than a fresh one, and that the
 * agent does not greet the caller a second time — and that is decided entirely by
 * the upgrade path this exercises for real (`parseWsUpgradeParams` →
 * `runtime.startSession`).
 *
 * The double's per-session counter stands in for a `sessionSlot`'s value. It is
 * NOT evidence about the real one: that lives in the session-state store
 * (`session-state-store.ts`), kept across a disconnect by the grace-window sweep
 * in `session-state-sweeps.ts`, and both have their own specs. What this adds is
 * the half no unit test covers — that the id a client reconnects with arrives
 * intact through a real severed connection and selects the same session.
 *
 * It says nothing about a PROCESS restart, and that is a statement of SCOPE
 * rather than of impossibility. The store has a Postgres backend, so a slot's
 * value really can outlive the process that wrote it. What keeps that out of
 * reach HERE is the setup: the runtime is a double holding its counter in a
 * plain `Map`, and one process serves every connection from the first test to
 * the last. The durable case is proved against a real database in
 * `aai-server/session-state.scenario.test.ts`, whose first case is named "a
 * slot's value survives a new process" — read it there rather than concluding
 * from this file that nothing survives a restart.
 */

import { sleep } from "@alexkroman1/aai/host-internal";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { createSeveringProxy, type SeveringProxy } from "./_fault-socket.ts";
import { silentLogger } from "./_test-utils.ts";
import { createRuntimeServer, type SessionRuntime } from "./server.ts";

/** What the double sends back, standing in for the runtime's `config` frame. */
type ConfigFrame = { type: "config"; sessionId: string; skipGreeting: boolean; starts: number };

type Harness = {
  proxy: SeveringProxy;
  /** Every `startSession` the server made, in order. */
  starts: { sessionId: string; resumeFrom: string | undefined; skipGreeting: boolean }[];
  close: () => Promise<void>;
};

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/**
 * A server whose runtime remembers sessions by id, behind a severing proxy.
 *
 * The counter is per SESSION ID, so a resume that lands on the same id sees the
 * previous connection's count and a new session starts from one — which is the
 * shape of the claim being tested, with none of a real transport in the way.
 */
async function serve(): Promise<Harness> {
  const sessions = new Map<string, number>();
  const starts: Harness["starts"] = [];
  let minted = 0;

  const runtime: SessionRuntime = {
    startSession(ws, opts) {
      // `resumeFrom` is what the client asked to continue; an unknown id is
      // honoured as an id rather than refused, matching the runtime — a client
      // holding a stale id gets a session, not an error.
      // Minted only when the client named no session, so the counter counts NEW
      // sessions rather than connections — which is what the assertions read.
      let sessionId = opts?.resumeFrom;
      if (sessionId === undefined) {
        minted += 1;
        sessionId = `sess_${minted}`;
      }
      const count = (sessions.get(sessionId) ?? 0) + 1;
      sessions.set(sessionId, count);
      starts.push({
        sessionId,
        resumeFrom: opts?.resumeFrom,
        skipGreeting: opts?.skipGreeting === true,
      });
      const frame: ConfigFrame = {
        type: "config",
        sessionId,
        skipGreeting: opts?.skipGreeting === true,
        starts: count,
      };
      ws.send(JSON.stringify(frame));
    },
    shutdown: () => Promise.resolve(),
  };

  const server = createRuntimeServer({ runtime, logger: silentLogger });
  await server.listen(0, "127.0.0.1");
  const target = server.port;
  if (target === undefined) throw new Error("server did not report a port");
  const proxy = await createSeveringProxy({ target });

  return {
    proxy,
    starts,
    close: async () => {
      await proxy.close();
      await server.close();
    },
  };
}

/** Connect through the proxy and resolve the `config` frame it answers with. */
async function connect(
  proxy: SeveringProxy,
  query = "",
): Promise<{ ws: WebSocket; config: ConfigFrame }> {
  const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/websocket${query}`);
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

describe("a session across a severed connection", () => {
  test("severing is abrupt — the client sees 1006, not a clean close", async () => {
    // 1006 is "no close frame received". A clean `ws.close()` would be 1000/1005
    // here, and the client treats that as a hangup it must NOT reconnect from —
    // so this assertion is what makes every test below about the right event.
    harness = await serve();
    const { ws } = await connect(harness.proxy);
    const closed = closeCode(ws);
    expect(harness.proxy.severAll()).toBe(1);
    await expect(closed).resolves.toBe(1006);
    expect(harness.proxy.severed()).toBe(1);
    expect(harness.proxy.live()).toBe(0);
  });

  test("reconnecting with the sessionId continues the SAME session and suppresses the greeting", async () => {
    harness = await serve();
    const first = await connect(harness.proxy);
    expect(first.config.skipGreeting).toBe(false);
    expect(first.config.starts).toBe(1);

    const closed = closeCode(first.ws);
    harness.proxy.severAll();
    await closed;

    const second = await connect(harness.proxy, `?sessionId=${first.config.sessionId}`);
    expect(second.config.sessionId).toBe(first.config.sessionId);
    // The greeting is the audible half of the contract: a caller who lost their
    // connection mid-sentence must not be greeted from the top on reconnect.
    expect(second.config.skipGreeting).toBe(true);
    // Same session ⇒ the per-session record from before the drop is still there.
    expect(second.config.starts).toBe(2);
    expect(harness.starts[1]?.resumeFrom).toBe(first.config.sessionId);
    second.ws.close();
  });

  test("reconnecting WITHOUT the id is a new session that DOES greet", async () => {
    // The negative half. Without it, a server that ignored the parameter and
    // always resumed the newest session would pass the test above.
    harness = await serve();
    const first = await connect(harness.proxy);
    const closed = closeCode(first.ws);
    harness.proxy.severAll();
    await closed;

    const second = await connect(harness.proxy);
    expect(second.config.sessionId).not.toBe(first.config.sessionId);
    expect(second.config.skipGreeting).toBe(false);
    expect(second.config.starts).toBe(1);
    second.ws.close();
  });

  test("`?resume` alone suppresses the greeting without naming a session", async () => {
    // A client that knows it is redialling but has lost the id: a new session,
    // and still no second greeting.
    harness = await serve();
    const { ws, config } = await connect(harness.proxy, "?resume=1");
    expect(config.skipGreeting).toBe(true);
    expect(config.starts).toBe(1);
    ws.close();
  });

  test("an empty `?sessionId=` is not a resume", async () => {
    // `parseWsUpgradeParams` treats a defined-but-empty id as absent, and the
    // giveaway if it did not would be a session keyed on the empty string —
    // every client sharing one.
    harness = await serve();
    const { ws, config } = await connect(harness.proxy, "?sessionId=");
    expect(config.sessionId).toMatch(/^sess_/);
    ws.close();
  });

  test("surviving repeated severs keeps landing on the same session", async () => {
    // "Continues after ANY disconnect" means more than one: each reconnect has to
    // carry the id forward, so a session that survives once but loses its state on
    // the second drop would fail here.
    harness = await serve();
    let current = await connect(harness.proxy);
    const id = current.config.sessionId;

    for (let attempt = 2; attempt <= 4; attempt += 1) {
      const closed = closeCode(current.ws);
      harness.proxy.severAll();
      await closed;
      current = await connect(harness.proxy, `?sessionId=${id}`);
      expect(current.config.sessionId).toBe(id);
      expect(current.config.starts).toBe(attempt);
      expect(current.config.skipGreeting).toBe(true);
    }
    expect(harness.proxy.severed()).toBe(3);
    current.ws.close();
  });

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
