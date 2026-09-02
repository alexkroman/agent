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
import { requestPath, STEP_WEBHOOK_URL_UNAVAILABLE_MESSAGE } from "@alexkroman1/aai/host-internal";
import { stepWebhookUrl } from "@alexkroman1/aai/step";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Logger } from "./runtime-config.ts";
import { WORKFLOW_QUEUE_PATH } from "./workflow-queue-dispatch.ts";
import {
  handleWorkflowRequest,
  isLoopbackAddress,
  MAX_QUEUE_DELIVERY_BODY_BYTES,
  publishWorkflowWebhookUrl,
  WORKFLOW_WEBHOOK_PREFIX,
  workflowWebhookUrl,
} from "./workflow-serve.ts";

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
  // Stands in for the guest's `ensureRuntime` getter, so a spec can observe WHEN
  // it is read and make it throw. Absent, `deliver` is handed over directly.
  onResolve?: () => void,
): Promise<{ url: string; port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const url = requestPath(req.url);
    if (
      !handleWorkflowRequest(
        req,
        res,
        url,
        req.method ?? "GET",
        omitUndefined({
          allowRemote,
          logger,
          deliver: () => {
            onResolve?.();
            return deliver;
          },
        }),
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

  test("resolves the engine only AFTER the bearer, so an unvouched caller builds nothing", async () => {
    // The guest supplies `deliver` as a getter over `ensureRuntime`, so reading
    // it BUILDS the runtime. Evaluated as an argument — which it was — an
    // unauthenticated request on the public sandbox tunnel forced that work.
    let resolved = 0;
    const s = await serving(
      async () => undefined,
      undefined,
      () => false,
      undefined,
      () => {
        resolved++;
      },
    );
    expect((await fetch(`${s.url}${WORKFLOW_QUEUE_PATH}`, { method: "POST" })).status).toBe(401);
    expect(resolved).toBe(0);
    await s.close();
  });

  test("a resolver that THROWS answers 500 instead of killing the process", async () => {
    // `ensureRuntime` throws for a bundle that has not loaded or a missing
    // provider credential. This runs inside `createServer`'s request hook, which
    // is called with no `try`, so an escaping throw was an `uncaughtException` —
    // and the guest's guard exits the process, taking every live voice session
    // with it. Driven through a real server because an ANSWER is the proof.
    const error = vi.fn();
    const s = await serving(
      async () => undefined,
      undefined,
      () => true,
      { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error },
      () => {
        throw new Error("Agent not loaded");
      },
    );
    const res = await fetch(`${s.url}${WORKFLOW_QUEUE_PATH}`, { method: "POST" });
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("Agent not loaded");
    expect(error).toHaveBeenCalledWith(
      "Workflow delivery unavailable",
      expect.objectContaining({ error: "Agent not loaded" }),
    );
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

  test("refuses an oversized delivery WITHOUT buffering it or reaching the handler", async () => {
    // `allowRemote` is not "trusted with unbounded memory". The door read its
    // body with no cap at all, so the platform's bearer — or anything holding a
    // sandbox's manage token — chose how many bytes of a guest's heap to spend,
    // on a process that is also serving live voice sessions.
    //
    // The assertion that matters is `deliver`, not the status: `readBody` counts
    // per chunk and DROPS the overflow, so the refusal happens as the bytes
    // arrive and `toFetchRequest` throws before `deliverQueueMessage` is ever
    // called. A 413 with the handler reached would mean the whole body was
    // buffered and only then measured, which is not a cap.
    const deliver = vi.fn(async () => undefined);
    const s = await serving(deliver, undefined, vouched);
    try {
      const res = await fetch(`${s.url}${WORKFLOW_QUEUE_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${BEARER}`, "x-vqs-queue-name": QUEUE_NAME },
        body: "x".repeat(MAX_QUEUE_DELIVERY_BODY_BYTES + 4096),
      });
      expect(res.status).toBe(413);
      expect(deliver).not.toHaveBeenCalled();
    } finally {
      await s.close();
    }
  });

  test("delivers a body at the cap, so the bound cannot refuse a real message", async () => {
    // The other half: a cap nothing legitimate can reach is a cap nobody
    // notices is wrong. The platform's enqueue route stores at most
    // `MAX_ENQUEUE_BODY_BYTES`, so a real delivery's payload fits under this by
    // construction — and a body exactly AT the limit must pass, since
    // `readBody` refuses on `>` rather than `>=`.
    const deliver = vi.fn(async () => undefined);
    const s = await serving(deliver, undefined, vouched);
    try {
      const res = await fetch(`${s.url}${WORKFLOW_QUEUE_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${BEARER}`, "x-vqs-queue-name": QUEUE_NAME },
        body: "x".repeat(MAX_QUEUE_DELIVERY_BODY_BYTES),
      });
      expect(res.status).toBe(200);
      expect(deliver).toHaveBeenCalledWith("wrun_7");
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

describe("workflowWebhookUrl", () => {
  test("composes the base with the route this package serves", () => {
    // Composed here rather than by the caller, so the URL handed out and the
    // path that answers it come from the same constant.
    expect(workflowWebhookUrl("https://agent.example.com", "approval:9")).toBe(
      `https://agent.example.com${WORKFLOW_WEBHOOK_PREFIX}approval%3A9`,
    );
  });

  test("encodes the token, because the route is ONE segment", () => {
    // `webhookToken` refuses a path with a second slash in it, so an unencoded
    // token would 404 at the far end days later.
    expect(workflowWebhookUrl("https://x", "a/b")).toBe(`https://x${WORKFLOW_WEBHOOK_PREFIX}a%2Fb`);
  });

  test("trims a trailing slash off the base", () => {
    // A copied-in origin ending in `/` is the ordinary shape of every source
    // this value arrives from — a boot env var, a container's PUBLIC_URL, an
    // author's own string.
    expect(workflowWebhookUrl("https://x//", "t")).toBe(`https://x${WORKFLOW_WEBHOOK_PREFIX}t`);
  });
});

describe("publishWorkflowWebhookUrl", () => {
  // Back to "nothing has published", so a spec here cannot leave a minter
  // behind for one in another file.
  afterEach(() => publishWorkflowWebhookUrl(undefined));

  test("fills the step slot, so a step can mint its own callback", () => {
    publishWorkflowWebhookUrl("https://agent.example.com/");
    expect(stepWebhookUrl("approval:9")).toBe(
      `https://agent.example.com${WORKFLOW_WEBHOOK_PREFIX}approval%3A9`,
    );
  });

  test("a blank or absent public URL UNPUBLISHES rather than minting a relative URL", () => {
    // `publicUrl: ""` would compose `/.well-known/…` — a URL nothing can call
    // back on — and the step helper's own throw names the configuration.
    publishWorkflowWebhookUrl("https://agent.example.com");
    publishWorkflowWebhookUrl("   ");
    expect(() => stepWebhookUrl("t")).toThrow(STEP_WEBHOOK_URL_UNAVAILABLE_MESSAGE);
    publishWorkflowWebhookUrl("https://agent.example.com");
    publishWorkflowWebhookUrl(undefined);
    expect(() => stepWebhookUrl("t")).toThrow(STEP_WEBHOOK_URL_UNAVAILABLE_MESSAGE);
  });
});
