// Copyright 2025 the AAI authors. MIT license.
/**
 * Tests for the sandbox-vm layer: the agent-server spawn dispatch (deployed
 * agents — the HTTP-only contract) and the deploy-time bundle-inspection
 * dispatch (one-shot describe execs). The Modal spawn backend is covered by
 * modal-sandbox.test.ts; shared helpers live in _sandbox-vm-test-utils.ts.
 */

import { describe, expect, it, vi } from "vitest";
import { baseOpts, makeHarnessFile } from "./_sandbox-vm-test-utils.ts";
import { DEFAULT_SANDBOX_IMAGE } from "./modal-context.ts";
import { localHarnessImageTag } from "./modal-harness-image.ts";
import { agentSandboxName } from "./sandbox-directory.ts";
import { describeBundle, guestUnderstandsBundleUrl, spawnAgentServer } from "./sandbox-vm.ts";
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
  it("dispatches to the backend with the worker source the guest verifies", async () => {
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
    const handle = fakeHandle();
    const spawn = vi.spyOn(subprocessSandbox, "spawnSubprocessAgentServer");
    spawn.mockResolvedValue(handle);
    const opts = baseOpts({ imageTag: "aai-guest-harness:abcd1234" });

    await spawnAgentServer(opts);

    expect(spawn).toHaveBeenCalledWith({
      harnessPath: opts.harnessPath,
      slug: opts.slug,
      worker: opts.worker,
      agentEnv: opts.env,
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
    // so any tag is by definition not the current one.
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
    const currentTag = localHarnessImageTag(
      process.env.MODAL_SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE,
      "// a specific harness",
    );
    expect(await guestUnderstandsBundleUrl(harnessPath, currentTag, {})).toBe(true);
    // Same backend, same harness, one character different in the tag — so the
    // `true` above is a real comparison rather than a short circuit that would
    // hand every pinned guest a URL.
    expect(await guestUnderstandsBundleUrl(harnessPath, `${currentTag}x`, {})).toBe(false);
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
