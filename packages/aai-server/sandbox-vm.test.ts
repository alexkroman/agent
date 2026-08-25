// Copyright 2025 the AAI authors. MIT license.
/**
 * Tests for the sandbox-vm layer: the agent-server spawn dispatch (deployed
 * agents — the HTTP-only contract) and the deploy-time bundle-inspection
 * dispatch (one-shot describe execs). The Modal spawn backend is covered by
 * modal-sandbox.test.ts; shared helpers live in _sandbox-vm-test-utils.ts.
 */

import { describe, expect, it, vi } from "vitest";
import { baseOpts } from "./_sandbox-vm-test-utils.ts";
import { emptyLogPage } from "./agent-logs.ts";
import { agentSandboxName } from "./sandbox-directory.ts";
import { guestReachableUrl, spawnAgentServer } from "./sandbox-vm.ts";
import * as subprocessSandbox from "./subprocess-sandbox.ts";
import type { AgentServerHandle } from "./warm-harness.ts";

// ── spawnAgentServer dispatch ────────────────────────────────────────────────

function fakeHandle(): AgentServerHandle {
  return {
    sessionUrl: "wss://tunnel.test:443/websocket",
    guestOrigin: "wss://tunnel.test:443",
    activeSessions: vi.fn(async () => 0),
    drain: vi.fn(async () => undefined),
    logs: vi.fn(async () => emptyLogPage()),
    alive: () => true,
    onExit: () => undefined,
    shutdown: vi.fn(async () => undefined),
  };
}

describe("spawnAgentServer", () => {
  it("dispatches to the backend with the worker source the guest verifies", async () => {
    const handle = fakeHandle();
    const subprocess = vi.fn(async () => handle);
    const modal = vi.fn(async () => handle);
    // Present because `BackendMap` is exhaustive over `SandboxBackend`, which is
    // the property that makes a new backend a compile error at every dispatch
    // site rather than a silent fall-through to Modal.
    const microsandbox = vi.fn(async () => handle);
    const opts = baseOpts({ imageTag: "aai-guest-harness:abcd1234" });

    // Named rather than inherited from an ambient default: the subject here is
    // WHICH backend the dispatcher reaches for, so the answer has to be stated.
    // The test env used to resolve `subprocess` by having no storage bucket,
    // which made this assertion depend on an unrelated variable being absent.
    vi.stubEnv("SANDBOX_BACKEND", "subprocess");
    const result = await spawnAgentServer(opts, { modal, microsandbox, subprocess });

    expect(result).toBe(handle);
    expect(modal).not.toHaveBeenCalled();
    expect(microsandbox).not.toHaveBeenCalled();
    // Every backend is handed the SAME spawn record — the Modal-only fields
    // included. Which of them a backend uses is that backend's business (the
    // subprocess entry in SANDBOX_BACKENDS drops them explicitly), not the
    // dispatcher's, so the dispatcher has no per-backend argument shaping left
    // to get wrong.
    expect(subprocess).toHaveBeenCalledWith({
      harnessPath: opts.harnessPath,
      slug: opts.slug,
      worker: opts.worker,
      agentEnv: opts.env,
      imageTag: "aai-guest-harness:abcd1234",
      name: agentSandboxName(opts.slug, opts.version),
    });
  });

  it("hands the real subprocess backend only the fields it accepts", async () => {
    // The Modal-only fields must not reach a backend that has no meaning for
    // them; asserting it here keeps the drop deliberate rather than a
    // side effect of the callee's signature.
    //
    // `onSpawned` is deliberately on the other side of that line — it is the
    // mid-boot kill `Sandbox.shutdown()` falls back to, which both backends owe
    // and which the entry in SANDBOX_BACKENDS must therefore forward rather
    // than drop alongside `imageTag`/`name`.
    vi.stubEnv("SANDBOX_BACKEND", "subprocess");
    const handle = fakeHandle();
    const spawn = vi.spyOn(subprocessSandbox, "spawnSubprocessAgentServer");
    spawn.mockResolvedValue(handle);
    const onSpawned = vi.fn();
    const opts = baseOpts({ imageTag: "aai-guest-harness:abcd1234", onSpawned });

    await spawnAgentServer(opts);

    expect(spawn).toHaveBeenCalledWith({
      harnessPath: opts.harnessPath,
      slug: opts.slug,
      // `name` is NOT a Modal-only field: both backends derive the guest's
      // manage token from it, so dropping it here would make the subprocess
      // backend the one place a token is random (see guest-token.ts).
      name: agentSandboxName(opts.slug, opts.version),
      worker: opts.worker,
      agentEnv: opts.env,
      onSpawned,
    });
  });
});

/**
 * The ONE seam for a URL crossing into a guest.
 *
 * The rule had been applied ad hoc three times before this existed — the
 * agent's env, the worker bundle's signed URL, and the platform origin an
 * in-guest `aai deploy` is given. The third was a 404 the guest returned to
 * itself, which is what the retired local-container backend was retired over.
 */
describe("guestReachableUrl", () => {
  it("rewrites a loopback origin for a microVM guest", () => {
    // A VM's 127.0.0.1 is the VM: unrewritten, `POST /deploy` reaches the
    // guest's own harness, which serves no such route.
    expect(guestReachableUrl("http://localhost:8080", { SANDBOX_BACKEND: "microsandbox" })).toBe(
      "http://host.microsandbox.internal:8080",
    );
    expect(guestReachableUrl("http://127.0.0.1:8080", { SANDBOX_BACKEND: "microsandbox" })).toBe(
      "http://host.microsandbox.internal:8080",
    );
  });

  it.each(["modal", "subprocess"] as const)("is identity on %s", (backend) => {
    // Modal reaches the platform's public origin over the internet; a
    // subprocess guest shares the host's network stack. Rewriting either would
    // point them at a host alias that does not exist.
    const url = "http://localhost:8080";
    expect(guestReachableUrl(url, { SANDBOX_BACKEND: backend })).toBe(url);
  });

  it("leaves a real public origin alone under every backend", () => {
    const url = "https://platform.example.com";
    expect(guestReachableUrl(url, { SANDBOX_BACKEND: "microsandbox" })).toBe(url);
  });
});
