// Copyright 2026 the AAI authors. MIT license.
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  createIdleController,
  createManageHandler,
  MANAGE_DRAIN_PATH,
  MANAGE_STATUS_PATH,
  readAgentBoot,
} from "./harness-agent-mode.ts";
import { GUEST_CONTRACT_VERSION } from "./limits.ts";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf-8").digest("hex");

async function writeBoot(opts: { code: string; sha?: string; env?: unknown }) {
  const dir = await mkdtemp(join(tmpdir(), "aai-agent-boot-"));
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
  return { bootEnv, dir };
}

describe("readAgentBoot", () => {
  test("reads the bundle and env, verifying the bundle hash", async () => {
    const { bootEnv } = await writeBoot({ code: "export default {}", env: { KEY: "v" } });
    const boot = await readAgentBoot(bootEnv);
    expect(boot.code).toBe("export default {}");
    expect(boot.env).toEqual({ KEY: "v" });
  });

  test("deletes the env file after reading (secrets leave the disk)", async () => {
    const { bootEnv } = await writeBoot({ code: "x", env: { KEY: "v" } });
    await readAgentBoot(bootEnv);
    await expect(access(bootEnv.AAI_AGENT_ENV_PATH as string)).rejects.toThrow();
  });

  test("a hash mismatch refuses to load", async () => {
    const { bootEnv } = await writeBoot({ code: "export default {}", sha: sha256("tampered") });
    await expect(readAgentBoot(bootEnv)).rejects.toThrow(/hash mismatch/);
  });

  test("missing bundle path/hash is a hard boot failure", async () => {
    await expect(readAgentBoot({})).rejects.toThrow(/AAI_BUNDLE_PATH/);
  });

  test("a non-object or non-string-valued env file is rejected", async () => {
    const arr = await writeBoot({ code: "x", env: ["nope"] });
    await expect(readAgentBoot(arr.bootEnv)).rejects.toThrow(/JSON object/);
    const bad = await writeBoot({ code: "x", env: { KEY: 7 } });
    await expect(readAgentBoot(bad.bootEnv)).rejects.toThrow(/must be a string/);
  });

  test("env file is optional — boots with an empty env", async () => {
    const { bootEnv } = await writeBoot({ code: "x" });
    expect((await readAgentBoot(bootEnv)).env).toEqual({});
  });

  test("the bundle file itself is untouched (only the env is scrubbed)", async () => {
    const { bootEnv } = await writeBoot({ code: "keep-me", env: {} });
    await readAgentBoot(bootEnv);
    expect(await readFile(bootEnv.AAI_BUNDLE_PATH as string, "utf-8")).toBe("keep-me");
  });
});

// ── Manage surface ─────────────────────────────────────────────────────────

type FakeRes = {
  statusCode: number | undefined;
  body: string;
  res: http.ServerResponse;
};

function fakeRes(): FakeRes {
  const out: FakeRes = { statusCode: undefined, body: "" } as FakeRes;
  out.res = {
    writeHead(status: number) {
      out.statusCode = status;
      return this;
    },
    end(body?: string) {
      out.body = body ?? "";
    },
  } as unknown as http.ServerResponse;
  return out;
}

function fakeReq(auth?: string): http.IncomingMessage {
  return { headers: auth ? { authorization: auth } : {} } as http.IncomingMessage;
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

  test("drain flips the drain flag", () => {
    const startDrain = vi.fn();
    const out = fakeRes();
    deps({ startDrain })(fakeReq("Bearer secret-token"), out.res, MANAGE_DRAIN_PATH, "POST");
    expect(out.statusCode).toBe(200);
    expect(startDrain).toHaveBeenCalledOnce();
  });

  test("an unknown manage path is claimed with a 404", () => {
    const out = fakeRes();
    expect(deps()(fakeReq("Bearer secret-token"), out.res, "/manage/other", "GET")).toBe(true);
    expect(out.statusCode).toBe(404);
  });
});

// ── Idle / drain lifecycle ──────────────────────────────────────────────────

describe("createIdleController", () => {
  test("exits after the idle window with no sessions", () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    try {
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
    } finally {
      vi.useRealTimers();
    }
  });

  test("live sessions keep resetting the idle clock", () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    let sessions = 1;
    try {
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
    } finally {
      vi.useRealTimers();
    }
  });

  test("a drain exits at the next empty poll, ignoring the idle window", () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    let sessions = 2;
    try {
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
    } finally {
      vi.useRealTimers();
    }
  });

  test("idleExitMs 0 disables idle self-exit", () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    try {
      const ctl = createIdleController({
        activeSessions: () => 0,
        idleExitMs: 0,
        pollMs: 1000,
        exit,
      });
      vi.advanceTimersByTime(3_600_000);
      expect(exit).not.toHaveBeenCalled();
      ctl.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
