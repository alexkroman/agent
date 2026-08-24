// Copyright 2025 the AAI authors. MIT license.
/**
 * Tests for the sandbox-vm layer: the agent-server spawn dispatch (deployed
 * agents — the HTTP-only contract) and the deploy-time bundle-inspection
 * dispatch (one-shot describe execs). The Modal spawn backend is covered by
 * modal-sandbox.test.ts; shared helpers live in _sandbox-vm-test-utils.ts.
 */

import { describe, expect, it, vi } from "vitest";
import { baseOpts, makeHarnessFile } from "./_sandbox-vm-test-utils.ts";
import { emptyLogPage } from "./agent-logs.ts";
import { sandboxBaseTag } from "./modal-context.ts";
import { localHarnessImageTag } from "./modal-harness-image.ts";
import { agentSandboxName } from "./sandbox-directory.ts";
import { guestUnderstandsBundleUrl, spawnAgentServer } from "./sandbox-vm.ts";
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
    const opts = baseOpts({ imageTag: "aai-guest-harness:abcd1234" });

    // Named rather than inherited from an ambient default: the subject here is
    // WHICH backend the dispatcher reaches for, so the answer has to be stated.
    // The test env used to resolve `subprocess` by having no storage bucket,
    // which made this assertion depend on an unrelated variable being absent.
    vi.stubEnv("SANDBOX_BACKEND", "subprocess");
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

// ── guestUnderstandsBundleUrl ────────────────────────────────────────────────

/**
 * The gate deciding whether a guest gets a signed bundle URL or the bytes.
 *
 * It exists because an agent's sandbox spawns from the harness image pinned
 * on its row at DEPLOY time, so the guest can be older than the platform, and
 * a pre-v2 harness reads only `AAI_BUNDLE_PATH` — handing it a URL fails its
 * boot outright. Nothing can ask a guest its contract version before exec, so
 * this compares images instead.
 *
 * Each case uses a distinct harness path: the current tag is memoized per
 * path (`currentTagMemo`), so a shared one would let the first case decide
 * the rest.
 */
describe("guestUnderstandsBundleUrl", () => {
  it("says yes for an unpinned spawn — that guest runs the current image", async () => {
    expect(await guestUnderstandsBundleUrl("/tmp/unpinned.mjs", undefined, {})).toBe(true);
  });

  it("says no for a pin that is not the tag this process builds", async () => {
    // The subprocess backend has no image at all (`harnessImageTag` → null),
    // so any tag is by definition not the current one. Named, because that is
    // the premise of the assertion rather than an ambient default.
    vi.stubEnv("SANDBOX_BACKEND", "subprocess");
    expect(await guestUnderstandsBundleUrl("/tmp/foreign.mjs", "aai-guest-harness:old", {})).toBe(
      false,
    );
  });

  it("says yes for a pin the operator has forced aside", async () => {
    // Must agree with resolveSpawnImage, which substitutes the CURRENT image
    // under this flag — so the guest really is the current harness, whatever
    // its row says. Disagreeing would hand a v1 guest a URL.
    expect(
      await guestUnderstandsBundleUrl("/tmp/forced.mjs", "aai-guest-harness:old", {
        SANDBOX_IGNORE_IMAGE_PINS: "1",
      }),
    ).toBe(true);
  });

  it("says yes for a pin that IS the tag this process builds", async () => {
    // The tag hashes the harness bundle's content, so "same tag" means "same
    // harness" — which is the question actually being asked.
    vi.stubEnv("SANDBOX_BACKEND", "modal");
    const harnessPath = await makeHarnessFile("// a specific harness");
    const currentTag = localHarnessImageTag(sandboxBaseTag(), "// a specific harness");
    expect(await guestUnderstandsBundleUrl(harnessPath, currentTag, {})).toBe(true);
    // Same backend, same harness, one character different in the tag — so the
    // `true` above is a real comparison rather than a short circuit that would
    // hand every pinned guest a URL.
    expect(await guestUnderstandsBundleUrl(harnessPath, `${currentTag}x`, {})).toBe(false);
  });
});
