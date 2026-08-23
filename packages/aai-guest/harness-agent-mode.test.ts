// Copyright 2026 the AAI authors. MIT license.
import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import type http from "node:http";
import { join } from "node:path";
import { errorMessage, omitUndefined } from "@alexkroman1/aai/utils";
import { WORKFLOW_FLOW_PATH } from "@alexkroman1/aai-runtime/internal";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useTempDirs } from "./_test-utils.ts";
import {
  createAgentRequestHandler,
  createIdleController,
  createManageHandler,
  createWorkflowActivity,
  MANAGE_DRAIN_PATH,
  MANAGE_STATUS_PATH,
  readAgentBoot,
} from "./harness-agent-mode.ts";
import { BUNDLE_FETCH_TIMEOUT_MS, GUEST_CONTRACT_VERSION } from "./limits.ts";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf-8").digest("hex");

const makeBootDir = useTempDirs("aai-agent-boot-");

/** The exec env a spawner would have written, in a self-removing temp dir. */
async function writeBoot(opts: {
  code: string;
  sha?: string;
  env?: unknown;
}): Promise<Record<string, string>> {
  const dir = await makeBootDir();
  const bundlePath = join(dir, "bundle.mjs");
  await writeFile(bundlePath, opts.code, "utf-8");
  const bootEnv: Record<string, string> = {
    AAI_BUNDLE_PATH: bundlePath,
    AAI_BUNDLE_SHA256: opts.sha ?? sha256(opts.code),
  };
  if (opts.env !== undefined) {
    const envPath = join(dir, "env.json");
    await writeFile(envPath, JSON.stringify(opts.env), "utf-8");
    bootEnv.AAI_AGENT_ENV_PATH = envPath;
  }
  return bootEnv;
}

describe("readAgentBoot", () => {
  test("reads the bundle and env, verifying the bundle hash", async () => {
    const bootEnv = await writeBoot({ code: "export default {}", env: { KEY: "v" } });
    const boot = await readAgentBoot(bootEnv);
    expect(boot.code).toBe("export default {}");
    expect(boot.env).toEqual({ KEY: "v" });
  });

  test("deletes the env file after reading (secrets leave the disk)", async () => {
    const bootEnv = await writeBoot({ code: "x", env: { KEY: "v" } });
    await readAgentBoot(bootEnv);
    await expect(access(bootEnv.AAI_AGENT_ENV_PATH as string)).rejects.toThrow();
  });

  test("a hash mismatch refuses to load", async () => {
    const bootEnv = await writeBoot({ code: "export default {}", sha: sha256("tampered") });
    await expect(readAgentBoot(bootEnv)).rejects.toThrow(/hash mismatch/);
  });

  test("missing bundle path/hash is a hard boot failure", async () => {
    await expect(readAgentBoot({})).rejects.toThrow(/AAI_BUNDLE_PATH/);
  });

  test("a non-object or non-string-valued env file is rejected", async () => {
    const arr = await writeBoot({ code: "x", env: ["nope"] });
    await expect(readAgentBoot(arr)).rejects.toThrow(/JSON object/);
    const bad = await writeBoot({ code: "x", env: { KEY: 7 } });
    await expect(readAgentBoot(bad)).rejects.toThrow(/must be a string/);
  });

  test("env file is optional — boots with an empty env", async () => {
    const bootEnv = await writeBoot({ code: "x" });
    expect((await readAgentBoot(bootEnv)).env).toEqual({});
  });

  test("the bundle file itself is untouched (only the env is scrubbed)", async () => {
    const bootEnv = await writeBoot({ code: "keep-me", env: {} });
    await readAgentBoot(bootEnv);
    expect(await readFile(bootEnv.AAI_BUNDLE_PATH as string, "utf-8")).toBe("keep-me");
  });

  // ── AAI_BUNDLE_URL: the guest fetches its own bundle ──────────────────────
  //
  // The platform hands a signed, expiring Storage URL instead of writing ~8 MB
  // into the sandbox. Everything that makes that safe is the hash check the
  // file path already had — so these tests are mostly about the hash still
  // being enforced when the bytes arrived over the network, where they could
  // have come from anywhere.

  test("fetches the bundle from AAI_BUNDLE_URL and verifies the same hash", async () => {
    const code = 'export default { name: "fetched" };';
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(code));
    const boot = await readAgentBoot({
      AAI_BUNDLE_URL: "https://blobs.test/signed",
      AAI_BUNDLE_SHA256: sha256(code),
    });
    expect(boot.code).toBe(code);
    expect(fetchMock).toHaveBeenCalledWith("https://blobs.test/signed", expect.anything());
  });

  test("the fetch is bounded by BUNDLE_FETCH_TIMEOUT_MS, not left to hang", async () => {
    // `expect.anything()` used to stand in for the whole init bag, and the
    // only thing in it is the 60s cap that keeps a hung Storage URL from
    // parking agent-mode boot against the host's 120s readiness budget —
    // dropping the signal entirely passed. Spying the timeout factory pins
    // both halves: that a deadline was minted at the declared duration, and
    // that THAT signal is the one the request carries.
    const code = "export default {};";
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(code));

    await readAgentBoot({
      AAI_BUNDLE_URL: "https://blobs.test/signed",
      AAI_BUNDLE_SHA256: sha256(code),
    });

    expect(timeoutSpy).toHaveBeenCalledExactlyOnceWith(BUNDLE_FETCH_TIMEOUT_MS);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(timeoutSpy.mock.results[0]?.value);
  });

  test("a fetched bundle whose hash does not match refuses to load", async () => {
    // The whole security argument for URL delivery: the guest trusts the
    // hash, never whoever served the bytes.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not the bundle"));
    await expect(
      readAgentBoot({
        AAI_BUNDLE_URL: "https://blobs.test/signed",
        AAI_BUNDLE_SHA256: sha256("export default {}"),
      }),
    ).rejects.toThrow(/hash mismatch/);
  });

  test("a rejected fetch fails the boot without echoing the URL", async () => {
    // The URL IS the read capability for the blob, and a boot failure's whole
    // job is to be printed to stderr and shipped to the host log.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("gone", { status: 400 }));
    const message = await readAgentBoot({
      AAI_BUNDLE_URL: "https://blobs.test/signed?token=secret",
      AAI_BUNDLE_SHA256: sha256("x"),
    }).then(
      () => "resolved without throwing",
      (err: unknown) => errorMessage(err),
    );
    // The first assertion is what keeps the second from passing vacuously.
    expect(message).toMatch(/HTTP 400/);
    expect(message).not.toContain("secret");
  });

  test("the URL wins over a path, so a v2 guest never reads a file nobody wrote", async () => {
    const code = "from-the-url";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(code));
    const bootEnv = await writeBoot({ code: "from-the-file" });
    const boot = await readAgentBoot({
      ...bootEnv,
      AAI_BUNDLE_URL: "https://blobs.test/signed",
      AAI_BUNDLE_SHA256: sha256(code),
    });
    expect(boot.code).toBe(code);
  });
});

// ── Manage surface ─────────────────────────────────────────────────────────

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
  opts: { method?: string } = {},
): http.IncomingMessage {
  return {
    headers: auth ? { authorization: auth } : {},
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

  test("notifies on each settle, which is when the queue's next wake changed", () => {
    const onSettled = vi.fn();
    const activity = createWorkflowActivity(onSettled);
    const one = fakeRes();
    activity.begin(one.res);
    expect(onSettled).not.toHaveBeenCalled();
    one.close();
    expect(onSettled).toHaveBeenCalledTimes(1);
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
});

// ── Idle / drain lifecycle ──────────────────────────────────────────────────

describe("createIdleController", () => {
  // Virtual time for the whole block. The teardown is needed; declaring it
  // per test as seven `try`/`finally` pairs was not — and a `finally` around a
  // whole test body is dead structure the moment a hook can carry it.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("exits after the idle window with no sessions", () => {
    const exit = vi.fn();
    const ctl = createIdleController({
      activeSessions: () => 0,
      idleExitMs: 10_000,
      pollMs: 1000,
      exit,
    });
    vi.advanceTimersByTime(9000);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(exit).toHaveBeenCalledWith(0);
    ctl.stop();
  });

  test("live sessions keep resetting the idle clock", () => {
    const exit = vi.fn();
    let sessions = 1;
    const ctl = createIdleController({
      activeSessions: () => sessions,
      idleExitMs: 10_000,
      pollMs: 1000,
      exit,
    });
    vi.advanceTimersByTime(60_000);
    expect(exit).not.toHaveBeenCalled();
    sessions = 0;
    vi.advanceTimersByTime(12_000);
    expect(exit).toHaveBeenCalledWith(0);
    ctl.stop();
  });

  test("a drain exits at the next empty poll, ignoring the idle window", () => {
    const exit = vi.fn();
    let sessions = 2;
    const ctl = createIdleController({
      activeSessions: () => sessions,
      idleExitMs: 0, // idle exit disabled — drain must still work
      pollMs: 1000,
      exit,
    });
    ctl.startDrain();
    expect(ctl.isDraining()).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(exit).not.toHaveBeenCalled(); // sessions still live
    sessions = 0;
    vi.advanceTimersByTime(1000);
    expect(exit).toHaveBeenCalledWith(0);
    ctl.stop();
  });

  test("a workflow callback in flight keeps the idle clock reset", () => {
    // Without this a wake buys at most one idle window of progress: the guest
    // the platform woke for a run has no session, so it exits mid-step and the
    // job stays locked until graphile-worker's 4-hour expiry.
    const exit = vi.fn();
    let workflows = 1;
    const ctl = createIdleController({
      activeSessions: () => 0,
      activeWorkflows: () => workflows,
      idleExitMs: 10_000,
      pollMs: 1000,
      exit,
    });
    vi.advanceTimersByTime(60_000);
    expect(exit).not.toHaveBeenCalled();
    workflows = 0;
    vi.advanceTimersByTime(12_000);
    expect(exit).toHaveBeenCalledWith(0);
    ctl.stop();
  });

  test("a drain waits out a workflow callback, then exits", () => {
    // A drain means "finish what you are doing, bounded by the deadline", and a
    // step is exactly that — so workflow work counts for the drain too.
    const exit = vi.fn();
    let workflows = 1;
    const ctl = createIdleController({
      activeSessions: () => 0,
      activeWorkflows: () => workflows,
      idleExitMs: 0,
      pollMs: 1000,
      exit,
    });
    ctl.startDrain();
    vi.advanceTimersByTime(5000);
    expect(exit).not.toHaveBeenCalled();
    workflows = 0;
    vi.advanceTimersByTime(1000);
    expect(exit).toHaveBeenCalledWith(0);
    ctl.stop();
  });

  test("the drain deadline still wins over workflow work", () => {
    const exit = vi.fn();
    const ctl = createIdleController({
      activeSessions: () => 0,
      activeWorkflows: () => 1, // never settles
      idleExitMs: 0,
      pollMs: 1000,
      exit,
    });
    ctl.startDrain(5000);
    vi.advanceTimersByTime(4000);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(exit).toHaveBeenCalledWith(0);
    ctl.stop();
  });

  test("idleExitMs 0 disables idle self-exit", () => {
    const exit = vi.fn();
    const ctl = createIdleController({
      activeSessions: () => 0,
      idleExitMs: 0,
      pollMs: 1000,
      exit,
    });
    vi.advanceTimersByTime(3_600_000);
    expect(exit).not.toHaveBeenCalled();
    ctl.stop();
  });
});
