// Copyright 2026 the AAI authors. MIT license.
import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@alexkroman1/aai/utils";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useTempDirs } from "./_test-utils.ts";
import { createIdleController, readAgentBoot } from "./harness-agent-mode.ts";
import { createWorkflowActivity, type WorkflowActivity } from "./harness-manage.ts";
import { BUNDLE_FETCH_TIMEOUT_MS } from "./limits.ts";

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

/**
 * The two halves of the livelock, asserted against the REAL activity counter
 * rather than a hand-held number.
 *
 * Every case in `createIdleController` above supplies `activeWorkflows` as a
 * literal, which is right for testing the controller and is exactly why the
 * livelock was invisible: the defect was in what FED that number, and both
 * modules' suites were green throughout. What is claimed here is the
 * composition — `createWorkflowActivity` wired into `createIdleController`, as
 * `mainAgent` wires them.
 */
describe("a running walk versus the idle reaper", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const controller = (activity: WorkflowActivity, exit: (code: number) => void) =>
    createIdleController({
      activeSessions: () => 0,
      activeWorkflows: activity.inFlight,
      idleExitMs: 10_000,
      pollMs: 1000,
      exit,
    });

  test("a walk in progress keeps the guest alive past the idle window", async () => {
    // Production: a 552.4 MB upload's step was still running when the guest
    // exited `AGENT_IDLE_EXIT_MS` after the platform's 60s ceiling closed the
    // delivery's response, and the fresh sandbox started the same upload again.
    // `TRANSCRIBE_UPLOAD_TIMEOUT_MS` is 30 minutes, so a healthy step may
    // legitimately outlive this window many times over.
    const exit = vi.fn();
    const activity = createWorkflowActivity();
    const step = Promise.withResolvers<string>();
    const ctl = controller(activity, exit);

    const walk = activity.walk(() => step.promise);
    // Thirty windows' worth. Nothing here settles the walk, and nothing should.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(exit).not.toHaveBeenCalled();

    step.resolve("completed");
    await walk;
    expect(activity.inFlight()).toBe(0);
    // And the window resumes from the walk's END, so the guest still dies.
    await vi.advanceTimersByTimeAsync(12_000);
    expect(exit).toHaveBeenCalledWith(0);
    ctl.stop();
  });

  test("a guest with NO walk still exits promptly", async () => {
    // The other direction, which is load-bearing: a guest must not bill
    // forever, so the fix may not simply make the counter sticky.
    const exit = vi.fn();
    const activity = createWorkflowActivity();
    const ctl = controller(activity, exit);
    expect(activity.inFlight()).toBe(0);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(exit).toHaveBeenCalledWith(0);
    ctl.stop();
  });

  test("a walk that FAILED releases the guest, so one bad step is not a leak", async () => {
    const exit = vi.fn();
    const activity = createWorkflowActivity();
    const ctl = controller(activity, exit);

    await expect(
      activity.walk(async () => {
        throw new Error("journal unreachable");
      }),
    ).rejects.toThrow(/journal unreachable/);

    await vi.advanceTimersByTimeAsync(12_000);
    expect(exit).toHaveBeenCalledWith(0);
    ctl.stop();
  });
});
