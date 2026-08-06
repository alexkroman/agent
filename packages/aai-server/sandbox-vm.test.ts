// Copyright 2025 the AAI authors. MIT license.
/**
 * Tests for the sandbox-vm layer: the agent-server spawn dispatch (deployed
 * agents — the HTTP-only contract) and the deploy-time bundle-inspection
 * dispatch (one-shot describe execs). The Modal spawn backend is covered by
 * modal-sandbox.test.ts; shared helpers live in _sandbox-vm-test-utils.ts.
 */

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { baseOpts } from "./_sandbox-vm-test-utils.ts";
import { agentSandboxName } from "./sandbox-directory.ts";
import { describeBundle, spawnAgentServer } from "./sandbox-vm.ts";
import * as subprocessSandbox from "./subprocess-sandbox.ts";
import type { AgentServerHandle } from "./warm-harness.ts";

// ── spawnAgentServer dispatch ────────────────────────────────────────────────

function fakeHandle(): AgentServerHandle {
  return {
    sessionUrl: "wss://tunnel.test:443/websocket",
    guestOrigin: "wss://tunnel.test:443",
    activeSessions: vi.fn(async () => 0),
    drain: vi.fn(async () => undefined),
    alive: () => true,
    onExit: () => undefined,
    shutdown: vi.fn(async () => undefined),
  };
}

describe("spawnAgentServer", () => {
  it("dispatches to the backend with the worker hash computed for the guest to verify", async () => {
    const handle = fakeHandle();
    const subprocess = vi.fn(async () => handle);
    const modal = vi.fn(async () => handle);
    const opts = baseOpts({ imageTag: "aai-guest-harness:abcd1234" });

    // Test env resolves the subprocess backend (no SUPABASE_STORAGE_BUCKET).
    const result = await spawnAgentServer(opts, { modal, subprocess });

    expect(result).toBe(handle);
    expect(modal).not.toHaveBeenCalled();
    // Every backend is handed the SAME spawn record — the Modal-only fields
    // included. Which of them a backend uses is that backend's business (the
    // subprocess entry in SANDBOX_BACKENDS drops them explicitly), not the
    // dispatcher's, so the dispatcher has no per-backend argument shaping left
    // to get wrong.
    expect(subprocess).toHaveBeenCalledWith({
      harnessPath: opts.harnessPath,
      slug: opts.slug,
      workerCode: opts.workerCode,
      workerSha256: createHash("sha256").update(opts.workerCode, "utf-8").digest("hex"),
      agentEnv: opts.env,
      imageTag: "aai-guest-harness:abcd1234",
      name: agentSandboxName(opts.slug, opts.version),
    });
  });

  it("hands the real subprocess backend only the fields it accepts", async () => {
    // The Modal-only fields must not reach a backend that has no meaning for
    // them; asserting it here keeps the drop deliberate rather than a
    // side effect of the callee's signature.
    const handle = fakeHandle();
    const spawn = vi.spyOn(subprocessSandbox, "spawnSubprocessAgentServer");
    spawn.mockResolvedValue(handle);
    const opts = baseOpts({ imageTag: "aai-guest-harness:abcd1234" });

    await spawnAgentServer(opts);

    expect(spawn).toHaveBeenCalledWith({
      harnessPath: opts.harnessPath,
      slug: opts.slug,
      workerCode: opts.workerCode,
      workerSha256: createHash("sha256").update(opts.workerCode, "utf-8").digest("hex"),
      agentEnv: opts.env,
    });
  });
});

// ── describeBundle ───────────────────────────────────────────────────────────

describe("describeBundle", () => {
  it("dispatches to the backend's one-shot describe exec", async () => {
    const opts = { harnessPath: "/tmp/harness.mjs", workerCode: "export default {};" };
    const subprocess = vi.fn(async () => ({ name: "studio-agent" }));
    const modal = vi.fn(async () => undefined);

    // Test env resolves the subprocess backend (no SUPABASE_STORAGE_BUCKET).
    const config = await describeBundle(opts, { modal, subprocess });

    expect(config).toEqual({ name: "studio-agent" });
    expect(modal).not.toHaveBeenCalled();
    expect(subprocess).toHaveBeenCalledWith(opts);
  });

  it("propagates a failed describe (a broken bundle must fail the deploy)", async () => {
    const subprocess = vi.fn(async () => {
      throw new Error("bundle failed to load: boom");
    });
    const modal = vi.fn(async () => undefined);
    await expect(
      describeBundle(
        { harnessPath: "/tmp/harness.mjs", workerCode: "throw 1" },
        { modal, subprocess },
      ),
    ).rejects.toThrow(/bundle failed to load/);
  });
});
