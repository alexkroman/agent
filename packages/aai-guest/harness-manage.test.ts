// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for a deployed guest's platform-facing HTTP surface.
 *
 * Split from `harness-agent-mode.test.ts` alongside the source, on the same
 * seam: this is every request the PLATFORM makes of a guest, while what is left
 * there is the guest's own lifecycle — reading its boot artifacts and deciding
 * when to exit.
 *
 * The two fakes are the reason this file's helpers travel with it. Each is the
 * ONE fake of its kind, extended rather than copied, because a second literal
 * would need a second cast to a `node:http` type and a concentration of
 * identical casts is a missing typed seam (see the escape-hatch ratchet in the
 * root AGENTS.md).
 */

import type http from "node:http";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { WORKFLOW_FLOW_PATH } from "@alexkroman1/aai-runtime/internal";
import { describe, expect, test, vi } from "vitest";
import {
  createAgentRequestHandler,
  createManageHandler,
  createWorkflowActivity,
  MANAGE_DRAIN_PATH,
  MANAGE_STATUS_PATH,
} from "./harness-manage.ts";
import { GUEST_PROXY_TOKEN_HEADER } from "./harness-workflow-gate.ts";
import { GUEST_CONTRACT_VERSION } from "./limits.ts";

type FakeRes = {
  statusCode: number | undefined;
  body: string;
  res: http.ServerResponse;
  /** Fire the `close` listeners, as ending a real response does. */
  close: () => void;
};

/**
 * The ONE fake response, `close` listeners included.
 *
 * Extended rather than copied for the workflow-activity specs: a second literal
 * would need a second cast to `http.ServerResponse`, and a concentration of
 * identical casts is a missing typed seam (see the escape-hatch ratchet in the
 * root CLAUDE.md).
 */
function fakeRes(): FakeRes {
  const listeners: (() => void)[] = [];
  const close = (): void => {
    for (const listener of listeners.splice(0)) listener();
  };
  const out: FakeRes = { statusCode: undefined, body: "", close } as FakeRes;
  out.res = {
    writeHead(status: number) {
      out.statusCode = status;
      return this;
    },
    end(body?: string) {
      out.body = body ?? "";
      // A real response emits `close` when it finishes, which is what settles
      // the workflow-activity count.
      close();
    },
    once(event: string, listener: () => void) {
      if (event === "close") listeners.push(listener);
      return this;
    },
  } as unknown as http.ServerResponse;
  return out;
}

/**
 * The ONE fake request. `method`/`body` exist for the workflow routes, which
 * read a body off the stream — same single-cast rule as `fakeRes` above.
 */
function fakeReq(
  auth?: string,
  url?: string,
  opts: { method?: string; headers?: Record<string, string>; remoteAddress?: string } = {},
): http.IncomingMessage {
  const headers: Record<string, string> = { ...opts.headers };
  if (auth) headers.authorization = auth;
  return {
    headers,
    // A LOOPBACK peer by default, which is what every real caller of this
    // handler is: the manage surface is dialled by the platform over the
    // sandbox tunnel, and the queue callbacks by the guest's own worker on
    // loopback — and `handleWorkflowRequest` refuses `flow`/`step` from
    // anywhere else (see `aai-runtime/workflow-serve.ts`). Omitting the socket
    // entirely made this fake fail that gate closed, which is the gate working:
    // a peer it cannot identify is not one it may call internal.
    socket: { remoteAddress: opts.remoteAddress ?? "127.0.0.1" } as http.IncomingMessage["socket"],
    ...omitUndefined({ url, method: opts.method }),
    async *[Symbol.asyncIterator]() {
      // No chunks: a queue callback's payload is irrelevant to the routing.
    },
  } as http.IncomingMessage;
}

describe("createManageHandler", () => {
  const deps = (over: Partial<Parameters<typeof createManageHandler>[0]> = {}) =>
    createManageHandler({
      token: "secret-token",
      activeSessions: () => 3,
      isDraining: () => false,
      startDrain: vi.fn(),
      ...over,
    });

  test("leaves non-manage paths unclaimed", () => {
    const handled = deps()(fakeReq(), fakeRes().res, "/websocket", "GET");
    expect(handled).toBe(false);
  });

  test("rejects a missing or wrong bearer with 401 (tunnel URL is public)", () => {
    const noAuth = fakeRes();
    expect(deps()(fakeReq(), noAuth.res, MANAGE_STATUS_PATH, "GET")).toBe(true);
    expect(noAuth.statusCode).toBe(401);

    const wrong = fakeRes();
    expect(deps()(fakeReq("Bearer nope"), wrong.res, MANAGE_STATUS_PATH, "GET")).toBe(true);
    expect(wrong.statusCode).toBe(401);
  });

  test("status reports sessions, draining, and the contract version", () => {
    const out = fakeRes();
    deps()(fakeReq("Bearer secret-token"), out.res, MANAGE_STATUS_PATH, "GET");
    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.body)).toEqual({
      activeSessions: 3,
      draining: false,
      contractVersion: GUEST_CONTRACT_VERSION,
    });
  });

  test("drain flips the drain flag (no query → no deadline)", () => {
    const startDrain = vi.fn();
    const out = fakeRes();
    deps({ startDrain })(fakeReq("Bearer secret-token"), out.res, MANAGE_DRAIN_PATH, "POST");
    expect(out.statusCode).toBe(200);
    expect(startDrain).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  test("drain forwards the host's deadline from the query", () => {
    const startDrain = vi.fn();
    const out = fakeRes();
    deps({ startDrain })(
      fakeReq("Bearer secret-token", `${MANAGE_DRAIN_PATH}?deadlineMs=60000`),
      out.res,
      MANAGE_DRAIN_PATH,
      "POST",
    );
    expect(out.statusCode).toBe(200);
    expect(startDrain).toHaveBeenCalledExactlyOnceWith(60_000);
  });

  test("drain ignores a malformed deadline (drains until empty)", () => {
    const startDrain = vi.fn();
    const out = fakeRes();
    deps({ startDrain })(
      fakeReq("Bearer secret-token", `${MANAGE_DRAIN_PATH}?deadlineMs=soon`),
      out.res,
      MANAGE_DRAIN_PATH,
      "POST",
    );
    expect(out.statusCode).toBe(200);
    expect(startDrain).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  test("an unknown manage path is claimed with a 404", () => {
    const out = fakeRes();
    expect(deps()(fakeReq("Bearer secret-token"), out.res, "/manage/other", "GET")).toBe(true);
    expect(out.statusCode).toBe(404);
  });
});

// ── Workflow activity ──────────────────────────────────────────────────────

describe("createWorkflowActivity", () => {
  test("counts a callback until its response closes", () => {
    const activity = createWorkflowActivity();
    const first = fakeRes();
    const second = fakeRes();

    activity.begin(first.res);
    activity.begin(second.res);
    expect(activity.inFlight()).toBe(2);

    first.close();
    expect(activity.inFlight()).toBe(1);
    second.close();
    expect(activity.inFlight()).toBe(0);
  });

  test("settles on a socket that died rather than a response that finished", () => {
    // `close` fires either way — which is the point. Waiting for `finish` would
    // leak the count on an aborted mid-step callback and pin the sandbox alive
    // for the rest of its Modal timeout.
    const activity = createWorkflowActivity();
    const aborted = fakeRes();
    activity.begin(aborted.res);
    aborted.close();
    expect(activity.inFlight()).toBe(0);
  });

  test("counts a callback as busy for as long as it is in flight", () => {
    // The one consumer left. The `onSettled` notifier this file used to carry
    // existed to republish the wake HINT — a per-app timestamp the platform read to
    // know when to boot a guest — and the platform reads its own queue now, so the
    // parameter is gone rather than left as a hook with no caller.
    const activity = createWorkflowActivity();
    const one = fakeRes();
    activity.begin(one.res);
    expect(activity.inFlight()).toBe(1);
    one.close();
    expect(activity.inFlight()).toBe(0);
  });
});

describe("createAgentRequestHandler", () => {
  const surface = {
    flow: () => Promise.resolve(new Response("{}", { status: 200 })),
    step: () => Promise.resolve(new Response("{}", { status: 200 })),
    webhook: () => Promise.resolve(new Response("{}", { status: 200 })),
  };

  const manage = {
    token: "secret-token",
    activeSessions: () => 0,
    isDraining: () => false,
    startDrain: vi.fn(),
  };

  test("tracks a claimed workflow callback as in-flight work", async () => {
    const activity = createWorkflowActivity();
    const handler = createAgentRequestHandler({ manage, workflows: () => surface, activity });
    const out = fakeRes();

    expect(
      handler(
        fakeReq(undefined, WORKFLOW_FLOW_PATH, { method: "POST" }),
        out.res,
        WORKFLOW_FLOW_PATH,
        "POST",
      ),
    ).toBe(true);
    expect(activity.inFlight()).toBe(1);

    // The handler serves in the background, so its own `res.end` is what
    // settles the count — no test-side prodding.
    await vi.waitFor(() => expect(activity.inFlight()).toBe(0));
  });

  test("does not count manage or unclaimed requests", () => {
    const activity = createWorkflowActivity();
    const handler = createAgentRequestHandler({ manage, workflows: () => surface, activity });

    expect(handler(fakeReq("Bearer secret-token"), fakeRes().res, MANAGE_STATUS_PATH, "GET")).toBe(
      true,
    );
    expect(handler(fakeReq(), fakeRes().res, "/websocket", "GET")).toBe(false);
    expect(activity.inFlight()).toBe(0);
  });

  describe("workflow-API proxy gate", () => {
    const handler = () => createAgentRequestHandler({ manage, workflows: () => surface });
    const withProxyToken = (token: string, url: string, method = "POST") =>
      fakeReq(undefined, url, { method, headers: { [GUEST_PROXY_TOKEN_HEADER]: token } });

    test.each(["/workflows", "/workflows/runs", "/workflows/runs/abc/events"])(
      "refuses a direct dial of %s with 401 (no proxy token)",
      (url) => {
        const out = fakeRes();
        expect(handler()(fakeReq(undefined, url, { method: "POST" }), out.res, url, "POST")).toBe(
          true,
        );
        expect(out.statusCode).toBe(401);
      },
    );

    test("refuses a WRONG proxy token with 401", () => {
      const out = fakeRes();
      const url = "/workflows/runs";
      expect(handler()(withProxyToken("not-the-token", url), out.res, url, "POST")).toBe(true);
      expect(out.statusCode).toBe(401);
    });

    test("a valid proxy token falls through untouched, so the runtime API serves it", () => {
      const out = fakeRes();
      const url = "/workflows/runs";
      // Not claimed (returns false) and the response is left alone — the runtime's
      // own workflow API (which then applies the AAI_WORKFLOW_API_TOKEN gate) is
      // what answers.
      expect(handler()(withProxyToken("secret-token", url), out.res, url, "POST")).toBe(false);
      expect(out.statusCode).toBeUndefined();
    });

    test("does not gate the loopback queue callbacks (different prefix)", () => {
      const out = fakeRes();
      // `/.well-known/workflow/v1/flow` is claimed by handleWorkflowRequest before
      // the gate, and carries no proxy token — this gate must never touch it.
      expect(
        handler()(
          fakeReq(undefined, WORKFLOW_FLOW_PATH, { method: "POST" }),
          out.res,
          WORKFLOW_FLOW_PATH,
          "POST",
        ),
      ).toBe(true);
      expect(out.statusCode).toBeUndefined();
    });

    // The proxy-token gate does not cover the callbacks and must not — but they
    // are not therefore OPEN on this hook. `handleWorkflowRequest` claims them
    // first and refuses an off-box peer, and asserting that here is what says
    // the deployed guest's own request hook inherits it: this handler is what a
    // request off the public Modal tunnel actually meets.
    test("refuses a queue callback dialled off-box, before the proxy gate", () => {
      const out = fakeRes();
      expect(
        handler()(
          fakeReq(undefined, WORKFLOW_FLOW_PATH, { method: "POST", remoteAddress: "10.0.0.4" }),
          out.res,
          WORKFLOW_FLOW_PATH,
          "POST",
        ),
      ).toBe(true);
      expect(out.statusCode).toBe(403);
    });
  });
});

// ── Idle / drain lifecycle ──────────────────────────────────────────────────
