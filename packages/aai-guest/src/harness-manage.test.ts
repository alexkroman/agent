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
import { WORKFLOW_QUEUE_PATH } from "@alexkroman1/aai-runtime/internal";
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

/** A `Response` body as `serveFetch` ends it: bytes, or nothing at all. */
function bodyText(body: Uint8Array | undefined): string {
  return body === undefined ? "" : Buffer.from(body).toString();
}

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
    end(body?: string | Uint8Array) {
      // BYTES, for anything that went through `serveFetch` — a `Response` body
      // arrives as a buffer, and reading it as a string gave `body` a comma
      // separated list of char codes that `toContain` cannot match.
      out.body = typeof body === "string" ? body : bodyText(body);
      // A real response emits `close` when it finishes — which the activity
      // counter used to settle on, and which the livelock spec below now fires
      // deliberately to show that a WALK outlives it.
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
    // `readBody` reads with `on("data" | "end" | "error")` rather than the async
    // iterator this used to expose — which is why every delivery spec here used
    // to log `Workflow delivery failed { error: 'req.on is not a function' }`
    // and pass anyway: they asserted only that the request was CLAIMED, and the
    // handler's own failure path answers a claimed request too. An empty body is
    // one `end` on the next turn.
    on(event: string, listener: () => void) {
      if (event === "end") queueMicrotask(listener);
      return this;
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
  test("counts a walk for as long as the walk RUNS", async () => {
    const activity = createWorkflowActivity();
    const first = Promise.withResolvers<string>();
    const second = Promise.withResolvers<string>();

    const walks = [activity.walk(() => first.promise), activity.walk(() => second.promise)];
    expect(activity.inFlight()).toBe(2);

    first.resolve("done");
    await walks[0];
    expect(activity.inFlight()).toBe(1);
    second.resolve("done");
    await walks[1];
    expect(activity.inFlight()).toBe(0);
  });

  test("answers the walk's own value, so it is a wrapper and not a fork", async () => {
    // The door AWAITS what this returns — `deliverQueueMessage` answers 200 or
    // rejects into a 500 off it — so a counter that dropped the value would
    // report every delivery completed.
    const activity = createWorkflowActivity();
    await expect(activity.walk(async () => "completed")).resolves.toBe("completed");
  });

  test("releases the count when a walk THREW", async () => {
    // Otherwise one failed step pins the sandbox alive for its whole Modal
    // lifetime — the leak this counter's `finally` is the whole of.
    const activity = createWorkflowActivity();
    await expect(
      activity.walk(async () => {
        throw new Error("journal unreachable");
      }),
    ).rejects.toThrow(/journal unreachable/);
    expect(activity.inFlight()).toBe(0);
  });
});

describe("createAgentRequestHandler", () => {
  /**
   * The engine's delivery hook, which is what the platform's door calls now.
   *
   * It replaced a fake `WorkflowSurface` with three handlers on it — `flow`,
   * `step` and `webhook`. Two went with the DevKit and the third moved to
   * `createServer`, so one door is left and it takes a run id.
   */
  const deliverWorkflow = () => async () => undefined;

  /** The queue door's own gate is the manage bearer — see `handleWorkflowRequest`. */
  const QUEUE_BEARER = "Bearer secret-token";

  const manage = {
    token: "secret-token",
    activeSessions: () => 0,
    isDraining: () => false,
    startDrain: vi.fn(),
  };

  /**
   * A delivery the platform would really send: the run id lives in the queue
   * NAME and nothing else, so a request without this header is a 400 that walks
   * nothing (which the old response-keyed counter counted anyway).
   */
  const queueReq = (queueName: string) =>
    fakeReq(QUEUE_BEARER, WORKFLOW_QUEUE_PATH, {
      method: "POST",
      headers: { "x-vqs-queue-name": queueName },
    });

  test("counts a walk that OUTLIVES its response, which is the livelock", async () => {
    // The measured production bug. The platform aborts the delivery's fetch at
    // `QUEUE_DELIVERY_TIMEOUT_MS` (60s) and the abort closes the RESPONSE
    // without stopping the walk, so a counter settled on `res.close` reported
    // an idle guest 60s into every long step — and the guest exited mid-upload
    // exactly `AGENT_IDLE_EXIT_MS` later, restarting the step in a fresh
    // sandbox forever. Here: the response ends, the walk does not, and the
    // count stays.
    const walking = Promise.withResolvers<string>();
    const activity = createWorkflowActivity();
    const handler = createAgentRequestHandler({
      manage,
      deliverWorkflow: () => async () => await walking.promise,
      activity,
    });
    const out = fakeRes();

    expect(handler(queueReq("__wkf_workflow_live_1"), out.res, WORKFLOW_QUEUE_PATH, "POST")).toBe(
      true,
    );
    await vi.waitFor(() => expect(activity.inFlight()).toBe(1));

    // The response is gone — `close` has fired, which is precisely what the old
    // signal keyed on — and the walk is still running.
    out.close();
    expect(activity.inFlight()).toBe(1);

    walking.resolve("completed");
    await vi.waitFor(() => expect(activity.inFlight()).toBe(0));
  });

  test("a PARKED redelivery counts nothing, so a dead walk cannot pin the guest", async () => {
    // The other half, and the reason the count is on the walker rather than on
    // the door: a park never calls the walker at all. Crediting one would keep
    // the sandbox alive for a walk nothing can see the health of, trading this
    // livelock for a leak.
    const walking = Promise.withResolvers<string>();
    const activity = createWorkflowActivity();
    const handler = createAgentRequestHandler({
      manage,
      deliverWorkflow: () => async () => await walking.promise,
      activity,
    });

    expect(
      handler(queueReq("__wkf_workflow_park_1"), fakeRes().res, WORKFLOW_QUEUE_PATH, "POST"),
    ).toBe(true);
    await vi.waitFor(() => expect(activity.inFlight()).toBe(1));

    // The same run again while the first walk runs: the door parks it.
    const parked = fakeRes();
    expect(
      handler(queueReq("__wkf_workflow_park_1"), parked.res, WORKFLOW_QUEUE_PATH, "POST"),
    ).toBe(true);
    await vi.waitFor(() => expect(parked.body).toContain("timeoutSeconds"));
    // Still ONE — the park added no credit of its own.
    expect(activity.inFlight()).toBe(1);

    walking.resolve("completed");
    await vi.waitFor(() => expect(activity.inFlight()).toBe(0));
  });

  test("an UNROUTABLE delivery counts nothing, because it walks nothing", async () => {
    // A claimed request is not work. This answers 400 before the walker is even
    // resolved, and the response-keyed counter credited it a full idle window.
    const activity = createWorkflowActivity();
    const handler = createAgentRequestHandler({ manage, deliverWorkflow, activity });
    const out = fakeRes();
    expect(handler(queueReq("__wkf_step_r1"), out.res, WORKFLOW_QUEUE_PATH, "POST")).toBe(true);
    await vi.waitFor(() => expect(out.statusCode).toBe(400));
    expect(activity.inFlight()).toBe(0);
  });

  test("does not count manage or unclaimed requests", () => {
    const activity = createWorkflowActivity();
    const handler = createAgentRequestHandler({ manage, deliverWorkflow, activity });

    expect(handler(fakeReq("Bearer secret-token"), fakeRes().res, MANAGE_STATUS_PATH, "GET")).toBe(
      true,
    );
    expect(handler(fakeReq(), fakeRes().res, "/websocket", "GET")).toBe(false);
    expect(activity.inFlight()).toBe(0);
  });

  describe("workflow-API proxy gate", () => {
    const handler = () => createAgentRequestHandler({ manage, deliverWorkflow });
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

    /**
     * The FAILING observation: `constantTimeEquals("", "")` is TRUE, so an empty
     * `x-aai-guest-token` against a blank expected token fell straight through
     * this gate — a direct dial of a deployed agent's workflow API off the public
     * Modal tunnel, with every platform rate limiter off the path.
     *
     * It was safe only because `harness.ts` exits on a falsy `AAI_GUEST_TOKEN`:
     * a defence in a different file guarding a comparison in this one. Same class
     * `bearerMatches` closed in the runtime, and the same remedy — refuse at the
     * COMPARISON too, and fail closed.
     */
    describe("a blank token", () => {
      const blank = () => createAgentRequestHandler({ manage: { ...manage, token: "" } });

      test.each([
        ["an empty header", ""],
        ["a whitespace-only header", "   "],
        ["a guessed token", "0".repeat(64)],
      ])("refuses %s against a blank expected token", (_label, token) => {
        const out = fakeRes();
        const url = "/workflows/runs";
        expect(blank()(withProxyToken(token, url), out.res, url, "POST")).toBe(true);
        expect(out.statusCode).toBe(401);
      });

      test("refuses an empty header against a REAL expected token", () => {
        // The supplied-side half. It catches nothing the expected-side guard does
        // not — a 64-hex token cannot equal `""` — and what it buys is that an
        // empty comparison is unreachable whatever the other guard becomes.
        const out = fakeRes();
        const url = "/workflows/runs";
        expect(handler()(withProxyToken("", url), out.res, url, "POST")).toBe(true);
        expect(out.statusCode).toBe(401);
      });

      test("refuses a whitespace-only expected token, which nothing can present", () => {
        // A header's optional whitespace is already stripped by the time it is
        // read, so `"  "` is unpresentable rather than merely odd — the same line
        // `isBlankSecret` draws, and it stops there: a PADDED token is left alone.
        const out = fakeRes();
        const url = "/workflows/runs";
        const padded = createAgentRequestHandler({ manage: { ...manage, token: "  " } });
        expect(padded(withProxyToken("  ", url), out.res, url, "POST")).toBe(true);
        expect(out.statusCode).toBe(401);
      });
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

    test("does not gate the platform's delivery door (different prefix)", () => {
      const out = fakeRes();
      // `/workflow-queue` is claimed by `handleWorkflowRequest` before this gate
      // and carries no proxy token — the proxy gate must never touch it.
      expect(
        handler()(
          fakeReq(QUEUE_BEARER, WORKFLOW_QUEUE_PATH, { method: "POST" }),
          out.res,
          WORKFLOW_QUEUE_PATH,
          "POST",
        ),
      ).toBe(true);
      expect(out.statusCode).toBeUndefined();
    });

    // The proxy-token gate does not cover the delivery door and must not — but
    // the door is not therefore OPEN on this hook. `handleWorkflowRequest` claims
    // it first and refuses a caller the composition cannot vouch for, and
    // asserting that here is what says the deployed guest's own request hook
    // inherits it: this handler is what a request off the public Modal tunnel
    // actually meets.
    //
    // The gate is now the BEARER rather than the peer's network position. The
    // DevKit's two callbacks were unauthenticated and loopback-gated because
    // their caller was the guest's own in-container worker; this door's caller is
    // the platform, outside the container, so a position check would refuse the
    // only legitimate caller there is.
    test("refuses a delivery with no bearer, before the proxy gate", () => {
      const out = fakeRes();
      expect(
        handler()(
          fakeReq(undefined, WORKFLOW_QUEUE_PATH, { method: "POST", remoteAddress: "10.0.0.4" }),
          out.res,
          WORKFLOW_QUEUE_PATH,
          "POST",
        ),
      ).toBe(true);
      expect(out.statusCode).toBe(401);
    });
  });
});

// ── Idle / drain lifecycle ──────────────────────────────────────────────────
