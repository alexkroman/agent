// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the PLATFORM's delivery door.
 *
 * This file used to be mostly about the DevKit's module loading — rewriting bare
 * specifiers so a bundle written to `/tmp` could resolve them — and that went with
 * the DevKit. What is left is one route and its gate, driven through a REAL http
 * server for the reason `serving` gives.
 */

import { createServer, type IncomingMessage } from "node:http";
import { networkInterfaces } from "node:os";
import { requestPath } from "@alexkroman1/aai/host-internal";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { describe, expect, test, vi } from "vitest";
import type { Logger } from "./runtime-config.ts";
import { WORKFLOW_QUEUE_PATH } from "./workflow-queue-dispatch.ts";
import { handleWorkflowRequest, isLoopbackAddress } from "./workflow-serve.ts";

/**
 * Serve the door from a REAL http server and return its base URL.
 *
 * A real server rather than fakes for node's `IncomingMessage`/`ServerResponse`:
 * the adapter's whole job is turning those into a `Request` and a `Response`
 * back again, and a hand-built pair proves nothing about the types the code
 * actually meets — it also cannot be constructed without casting, which is the
 * signal that the fake is the wrong tool.
 */
async function serving(
  // Re-walk one run. Absent is an agent that declares no workflows, and the door
  // then DECLINES rather than answering.
  deliver: ((runId: string) => Promise<unknown>) | undefined,
  // Every interface, for the one spec that has to arrive from off-box. Loopback
  // otherwise, which is what the rest of these are about.
  host = "127.0.0.1",
  // What a composition WITH a platform supplies. Absent is the default because
  // absent is what `aai dev`, host mode and a self-hosted server all pass.
  allowRemote?: (req: IncomingMessage) => boolean,
  // Where a failed handler is reported. Injected rather than spied on, because
  // `consoleLogger` captures `console.error` BY REFERENCE at module load — a
  // `vi.spyOn(console, "error")` installed by a test replaces the global
  // afterwards and the captured reference never sees it.
  logger?: Logger,
): Promise<{ url: string; port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const url = requestPath(req.url);
    if (
      !handleWorkflowRequest(
        req,
        res,
        url,
        req.method ?? "GET",
        omitUndefined({ allowRemote, logger, deliver }),
      )
    ) {
      res.writeHead(404);
      res.end("unclaimed");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * This host's first non-loopback IPv4 address, or undefined when it has none.
 *
 * The gate's whole claim is about a peer that is NOT loopback, and the only way
 * to produce one without a second machine is to dial this host by an address
 * that is not `127.0.0.0/8` — which needs a real interface. A container with
 * only `lo` legitimately has none, so the spec that needs this ANNOUNCES its
 * skip rather than passing vacuously.
 */
function firstExternalIpv4(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return undefined;
}

describe("handleWorkflowRequest", () => {
  /** A door with a platform vouching for its caller — the deployed shape. */
  const vouched = () => true;

  test("declines when the agent declares no workflows, rather than answering", async () => {
    // DECLINED and not answered: no engine here is indistinguishable from an
    // agent with no workflows, and claiming the request would shadow whatever
    // else the host serves on that path.
    const s = await serving(undefined, undefined, vouched);
    expect((await fetch(`${s.url}${WORKFLOW_QUEUE_PATH}`, { method: "POST" })).status).toBe(404);
    await s.close();
  });

  test("re-walks the run the delivery names, and answers 200", async () => {
    const walked: string[] = [];
    const s = await serving(
      async (runId) => {
        walked.push(runId);
      },
      undefined,
      vouched,
    );
    const res = await fetch(`${s.url}${WORKFLOW_QUEUE_PATH}`, {
      method: "POST",
      headers: { "x-vqs-queue-name": "__wkf_workflow_wrun_7" },
      body: `{"runId":"wrun_7"}`,
    });
    expect(res.status).toBe(200);
    expect(walked).toEqual(["wrun_7"]);
    await s.close();
  });

  test("REFUSES a delivery when the composition vouches for nobody", async () => {
    // Fails closed, which is every composition with no platform: `aai dev`, host
    // mode and a self-hosted server all have their queue inside the process, so a
    // delivery arriving from outside is a caller none of them can vouch for.
    const deliver = vi.fn(async () => undefined);
    const s = await serving(deliver);
    expect((await fetch(`${s.url}${WORKFLOW_QUEUE_PATH}`, { method: "POST" })).status).toBe(401);
    expect(deliver).not.toHaveBeenCalled();
    await s.close();
  });

  test("declines a non-POST, which is not a browsable surface", async () => {
    const s = await serving(async () => undefined, undefined, vouched);
    expect((await fetch(`${s.url}${WORKFLOW_QUEUE_PATH}`)).status).toBe(404);
    await s.close();
  });

  test("declines an unrelated path so it falls through to the rest of the server", async () => {
    const s = await serving(async () => undefined, undefined, vouched);
    expect((await fetch(`${s.url}/health`)).status).toBe(404);
    await s.close();
  });

  test("answers 500 when a replay throws, rather than taking the guest down", async () => {
    // This runs off a node request event, so an unhandled rejection would kill
    // the process mid-run. 500 is also what makes the platform retry — which is
    // right here: a guest that was up and could not finish is what a retry is for.
    const error = vi.fn();
    const s = await serving(
      async () => {
        throw new Error("boom");
      },
      undefined,
      vouched,
      { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error },
    );
    const res = await fetch(`${s.url}${WORKFLOW_QUEUE_PATH}`, {
      method: "POST",
      headers: { "x-vqs-queue-name": "__wkf_workflow_r1" },
    });
    expect(res.status).toBe(500);
    expect(error).toHaveBeenCalledWith(
      "Workflow delivery failed",
      expect.objectContaining({ error: "boom" }),
    );
    await s.close();
  });
});

describe("isLoopbackAddress", () => {
  // The whole 127/8 block, not just `127.0.0.1`: `localhost` resolves to
  // `127.0.0.2` and up on some hosts, and refusing those would refuse the
  // guest's OWN queue — a wedge with no error anyone would connect to a gate.
  test.each(["127.0.0.1", "127.0.0.2", "127.255.255.254", "::1", "::ffff:127.0.0.1"])(
    "accepts the loopback peer %s",
    (addr) => {
      expect(isLoopbackAddress(addr)).toBe(true);
    },
  );

  test.each([
    "10.0.0.4",
    "192.168.1.9",
    "172.17.0.2",
    "::ffff:10.0.0.4",
    "2001:db8::1",
    // Not 127/8 despite the prefix — a substring test would take both.
    "127.0.0.1.example.com",
    "1127.0.0.1",
  ])("refuses the off-box peer %s", (addr) => {
    expect(isLoopbackAddress(addr)).toBe(false);
  });

  // FAIL CLOSED. A socket with no peer address is one whose position cannot be
  // established, and the one answer this must never give is "internal, because
  // I could not tell".
  test.each([undefined, ""])("refuses a peer it cannot identify (%s)", (addr) => {
    expect(isLoopbackAddress(addr)).toBe(false);
  });
});

describe("the platform's delivery door", () => {
  const BEARER = "sandbox-token";
  const vouched = (req: IncomingMessage) => req.headers.authorization === `Bearer ${BEARER}`;
  const QUEUE_NAME = "__wkf_workflow_wrun_7";

  test("serves a vouched-for caller from OFF-BOX, which is the whole point", async () => {
    // The door exists for a caller OUTSIDE the container — the platform's queue,
    // holding the schedule of a run whose guest self-exited. A gate on network
    // position would refuse the only legitimate caller there is.
    const external = firstExternalIpv4();
    if (!external) {
      expect.fail("no non-loopback IPv4 interface: cannot produce an off-box peer here");
    }
    const deliver = vi.fn(async () => undefined);
    const s = await serving(deliver, "0.0.0.0", vouched);
    try {
      const res = await fetch(`http://${external}:${s.port}${WORKFLOW_QUEUE_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${BEARER}`, "x-vqs-queue-name": QUEUE_NAME },
        body: `{"runId":"wrun_7"}`,
      });
      expect(res.status).toBe(200);
      expect(deliver).toHaveBeenCalledWith("wrun_7");
    } finally {
      await s.close();
    }
  });

  test.each([
    ["no bearer", undefined],
    ["the wrong bearer", "Bearer nope"],
  ])("answers 401 for %s, and re-walks nothing", async (_label, authorization) => {
    const deliver = vi.fn(async () => undefined);
    const s = await serving(deliver, "0.0.0.0", vouched);
    try {
      const res = await fetch(`${s.url}${WORKFLOW_QUEUE_PATH}`, {
        method: "POST",
        headers: {
          "x-vqs-queue-name": QUEUE_NAME,
          ...omitUndefined({ authorization }),
        },
        body: `{"runId":"wrun_7"}`,
      });
      expect(res.status).toBe(401);
      expect(deliver).not.toHaveBeenCalled();
    } finally {
      await s.close();
    }
  });

  /**
   * FAILS CLOSED with no predicate, and LOOPBACK IS NOT ENOUGH.
   *
   * `aai dev`, host mode and a self-hosted server supply no predicate and have no
   * queue outside the process — their dispatcher is a `setTimeout` in it — so a
   * door that opened on loopback there would be an unauthenticated way to drive a
   * run: reachable by any local process, and on a self-hosted server bound to
   * `0.0.0.0`, by the network.
   *
   * This used to be stated against `flow`/`step`, which were guest-internal and
   * for which loopback WAS the whole gate. They are gone, so the contrast is now
   * with nothing — which makes the property easier to lose, not harder, and is
   * why it keeps its own case.
   */
  test("is refused when the composition vouches for nobody, even on loopback", async () => {
    const deliver = vi.fn(async () => undefined);
    const s = await serving(deliver);
    try {
      const res = await fetch(`${s.url}${WORKFLOW_QUEUE_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${BEARER}`, "x-vqs-queue-name": QUEUE_NAME },
        body: `{"runId":"wrun_7"}`,
      });
      expect(res.status).toBe(401);
      expect(deliver).not.toHaveBeenCalled();
    } finally {
      await s.close();
    }
  });
});
