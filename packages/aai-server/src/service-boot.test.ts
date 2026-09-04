// Copyright 2026 the AAI authors. MIT license.
/**
 * What a service ANNOUNCES and GUARDS at boot.
 *
 * Almost every claim in `service-boot.ts` is about the DIFFERENCE between a
 * warning and a throw, and the module's own doc is explicit that a diagnostic
 * may not take the process down. That distinction is invisible in a diff and
 * expensive to get wrong in both directions — a warning where a throw belongs is
 * a production server that accepts traffic and fails every spawn, and a throw
 * where a warning belongs is a dev server that will not start over a missing
 * local artifact. So each branch is asserted on which one it picks.
 *
 * Modal is mocked out entirely: `isModalConfigured` builds a real client, which
 * reads `~/.modal.toml`, so the unmocked version answers differently on a
 * developer's machine than in CI — and answering "yes" there would fire a real
 * prewarm at Modal's control plane from a unit test.
 */

import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sleep } from "@alexkroman1/aai/internal";
import { beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";
import { resolveHarnessPath } from "./constants.ts";
import { registerLiveStream } from "./live-streams.ts";
import { LOCAL_GUEST_IMAGE_TAG } from "./microsandbox-sandbox.ts";
import { isModalConfigured, prewarmModal } from "./modal-context.ts";
import { assertSandboxBackendOrWarn, installProcessSafetyNets } from "./service-boot.ts";
import { captureLogs } from "./test-utils.ts";

/**
 * The microVM image lookup, typed by what the CALLER does with it: the boot
 * check only awaits it, so a fake needs no `ImageHandle` and therefore no cast
 * to stand in for one.
 *
 * `microsandbox` is imported dynamically and nowhere else at run time (the one
 * static import of it in this package is type-only), so this factory replaces
 * the whole module rather than spreading the original.
 */
const { imageGet } = vi.hoisted(() => ({
  imageGet: vi.fn<(reference: string) => Promise<void>>(),
}));

vi.mock("microsandbox", () => ({ Image: { get: imageGet } }));

vi.mock("./modal-context.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./modal-context.ts")>()),
  isModalConfigured: vi.fn<() => boolean>(),
  prewarmModal: vi.fn<(harnessPath?: string) => void>(),
}));

vi.mock("./constants.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./constants.ts")>()),
  resolveHarnessPath: vi.fn<() => string>(),
}));

/** `AAI_LOCAL_DEV=1` and nothing else — what selects the microVM backend. */
const LOCAL_DEV: NodeJS.ProcessEnv = { AAI_LOCAL_DEV: "1" };

// The one piece of per-test bookkeeping the shared config does not cover:
// `restoreMocks` restores SPIES, and every mock above is a `vi.fn()` created
// once per FILE by a module factory, so its call history is cumulative. Verified
// by A/B — without this, "prewarmModal was not called" passed only in whichever
// test ran first, and every later assertion on a call count was really an
// assertion about test order.
beforeEach(() => {
  vi.clearAllMocks();
});

describe("assertSandboxBackendOrWarn", () => {
  const logs = captureLogs();

  test("names the selected backend and WHY, unconditionally", () => {
    vi.mocked(isModalConfigured).mockReturnValue(true);
    vi.mocked(resolveHarnessPath).mockReturnValue("/built/harness.mjs");

    assertSandboxBackendOrWarn({});

    // The auto-selected case is the confusing one and used to produce no output
    // at all, surfacing instead as a spawn failure naming an unexpected backend.
    expect(logs.infos()).toEqual([expect.stringContaining("backend=modal (not local dev)")]);
  });

  test("subprocess says out loud that tenant code runs with NO isolation", () => {
    assertSandboxBackendOrWarn({ SANDBOX_BACKEND: "subprocess" });

    expect(logs.warns()).toHaveLength(1);
    expect(logs.warns()[0]).toContain("NO isolation");
    // And it stops there: the backend with no boundary has no image to bake and
    // no Modal context to resolve.
    expect(prewarmModal).not.toHaveBeenCalled();
  });

  test("production without Modal credentials REFUSES to boot", () => {
    vi.mocked(isModalConfigured).mockReturnValue(false);

    // Fatal, not a warning: the alternative is a server that accepts traffic
    // and fails every session's spawn. `modal` is the DEFAULT, so this is what
    // an environment that sets no variable at all gets.
    expect(() => assertSandboxBackendOrWarn({})).toThrow(/MODAL_TOKEN_ID/);
    expect(prewarmModal).not.toHaveBeenCalled();
  });

  test("local dev without them warns, so non-sandbox surfaces stay usable", () => {
    vi.mocked(isModalConfigured).mockReturnValue(false);

    // `AAI_LOCAL_DEV=1` alone selects microsandbox, so reaching the Modal branch
    // locally takes the explicit override — which is the case a developer hits
    // when pointing a laptop at the real backend.
    const env = { ...LOCAL_DEV, SANDBOX_BACKEND: "modal" };
    expect(() => assertSandboxBackendOrWarn(env)).not.toThrow();

    expect(logs.warns()).toHaveLength(1);
    expect(prewarmModal).not.toHaveBeenCalled();
  });

  test("with credentials it prewarms Modal AND the guest image at boot", () => {
    vi.mocked(isModalConfigured).mockReturnValue(true);
    vi.mocked(resolveHarnessPath).mockReturnValue("/built/harness.mjs");

    assertSandboxBackendOrWarn({});

    // Otherwise the gRPC round trip and — far more expensive, and unavoidable on
    // the first boot of a new harness version — the image build land on one
    // unlucky user's first session.
    expect(prewarmModal).toHaveBeenCalledWith("/built/harness.mjs");
    expect(logs.warns()).toEqual([]);
  });

  test("an unbuilt harness warns and prewarms WITHOUT one", () => {
    vi.mocked(isModalConfigured).mockReturnValue(true);
    vi.mocked(resolveHarnessPath).mockImplementation(() => {
      throw new Error("Guest harness not built");
    });

    expect(() => assertSandboxBackendOrWarn({})).not.toThrow();

    // The Modal context is still worth resolving; only the image bake needs the
    // harness. Handing the prewarm no path is what keeps a missing dev artifact
    // from being a failed boot.
    expect(prewarmModal).toHaveBeenCalledWith(undefined);
    expect(logs.warns()).toHaveLength(1);
  });
});

describe("the microsandbox backend's guest-image check", () => {
  const logs = captureLogs();

  test("a registry-configured dev server looks for no LOCAL image", async () => {
    // One test rather than two because the check is fire-and-forget, and
    // "nothing was logged" needs a BARRIER: the second call below does warn, so
    // once its line has arrived the first call has had its chance to write one.
    vi.stubEnv("GUEST_IMAGE_REGISTRY", "ghcr.io/owner");
    assertSandboxBackendOrWarn(LOCAL_DEV);

    vi.stubEnv("GUEST_IMAGE_REGISTRY", undefined);
    imageGet.mockRejectedValue(new Error("no such image"));
    assertSandboxBackendOrWarn(LOCAL_DEV);
    await vi.waitFor(() => expect(logs.warns()).toHaveLength(1));

    // There is nothing local to find when the image is pulled by reference, so
    // the lookup belongs only to the second run.
    expect(imageGet).toHaveBeenCalledTimes(1);
    expect(imageGet).toHaveBeenCalledWith(LOCAL_GUEST_IMAGE_TAG);
  });

  test("a missing local image names the command that builds one", async () => {
    imageGet.mockRejectedValue(new Error("image not found"));

    assertSandboxBackendOrWarn(LOCAL_DEV);

    // Without the line the first session pays a 30-second dial timeout against
    // a sandbox that never started, and the error reads as a guest that failed
    // to boot rather than an image nobody built — one command from fixed, with
    // nothing saying which command.
    await vi.waitFor(() => expect(logs.warns()).toHaveLength(1));
    expect(logs.warns()[0]).toContain("build:guest-image --msb");
  });
});

/** A harness on disk, plus the stamp path a build would write beside it. */
async function harnessOnDisk(
  code: string,
): Promise<{ path: string; stamp: string; digest: string }> {
  const dir = await mkdtemp(join(tmpdir(), "aai-service-boot-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "harness.mjs");
  await writeFile(path, code, "utf-8");
  return {
    path,
    stamp: join(dir, ".guest-image-stamp.json"),
    digest: createHash("sha256").update(code).digest("hex"),
  };
}

describe("the local guest image's staleness stamp", () => {
  const logs = captureLogs();

  /**
   * Run the boot check with the image PRESENT, and wait until its stamp read
   * has happened.
   *
   * Two barriers, both load-bearing: the lookup is awaited (so the read cannot
   * have run when the call returns), and the read is that lookup's synchronous
   * continuation (so a `waitFor` on the lookup alone can pass one microtask too
   * early).
   */
  async function checkStamp(harnessPath: string): Promise<void> {
    imageGet.mockResolvedValue(undefined);
    vi.mocked(resolveHarnessPath).mockReturnValue(harnessPath);
    assertSandboxBackendOrWarn(LOCAL_DEV);
    await vi.waitUntil(() => imageGet.mock.calls.length === 1);
    await sleep(0);
  }

  test("an image built from the harness on disk is silent", async () => {
    const fresh = await harnessOnDisk("// harness v2");
    await writeFile(fresh.stamp, JSON.stringify({ harnessSha256: fresh.digest }));

    await checkStamp(fresh.path);

    expect(logs.all()).toEqual([expect.objectContaining({ level: "info" })]);
  });

  test("an image built from a DIFFERENT harness is reported stale, by digest", async () => {
    // The local tag is mutable, so an image and the harness beside it drift with
    // nothing saying so and every guest runs whatever was current when the image
    // was last built. Both digests ride the line, which is also what proves this
    // is a content comparison rather than the mtime heuristic it replaced.
    const drifted = await harnessOnDisk("// harness v2");
    const built = "0".repeat(64);
    await writeFile(drifted.stamp, JSON.stringify({ harnessSha256: built }));

    await checkStamp(drifted.path);

    expect(logs.all().filter((line) => line.level === "warn")).toMatchObject([
      { ctx: { built, current: drifted.digest } },
    ]);
  });

  test("an ABSENT stamp is reported the same way", async () => {
    // An image built before the stamp existed is exactly the case worth warning
    // about, and a rebuild writes one — so "unverifiable" is not "fine".
    const unstamped = await harnessOnDisk("// harness v2");

    await checkStamp(unstamped.path);

    expect(logs.all().filter((line) => line.level === "warn")).toMatchObject([
      { ctx: { stamp: unstamped.stamp } },
    ]);
  });

  test("a corrupt stamp SKIPS the check instead of failing boot", async () => {
    // A diagnostic may not fail a boot, and it may not be silent either: the
    // reason rides the line, so an unreadable stamp is distinguishable from an
    // image that is merely stale.
    const corrupt = await harnessOnDisk("// harness v2");
    await writeFile(corrupt.stamp, "{ not json");

    await checkStamp(corrupt.path);

    expect(logs.all().filter((line) => line.level === "warn")).toMatchObject([
      { ctx: { error: expect.stringContaining("JSON") } },
    ]);
  });
});

describe("installProcessSafetyNets", () => {
  const logs = captureLogs();

  /**
   * The two handlers it registers, captured from `process.on` rather than
   * installed for real.
   *
   * A spec that registered them would leave an `uncaughtException` listener on
   * the process for the rest of the file — the one event whose listeners decide
   * whether the runner reports a crash — and `restoreMocks` cannot remove a
   * process listener. Stubbing the registration also makes the assertion the
   * honest one: what this function promises is that both events are covered.
   */
  function handlers(): { rejection: (err: unknown) => void; exception: (err: unknown) => void } {
    const on = vi.spyOn(process, "on").mockReturnValue(process);
    installProcessSafetyNets();
    const registered = new Map(on.mock.calls.map(([event, listener]) => [event, listener]));
    const rejection = registered.get("unhandledRejection");
    const exception = registered.get("uncaughtException");
    if (!(rejection && exception)) {
      throw new Error(`boot registered ${JSON.stringify([...registered.keys()])}`);
    }
    return { rejection, exception };
  }

  test("an unhandled rejection is logged and the process keeps serving", () => {
    const { rejection } = handlers();

    rejection(new Error("a floating promise"));

    // Deliberately not fatal: a rejection nobody awaited says nothing about
    // whether this replica can still answer requests.
    expect(logs.errors()).toHaveLength(1);
  });

  test("an uncaught exception ENDS live streams before it exits", () => {
    // `process.exit` destroys sockets mid-body, so every live SSE stream would
    // be cut before its terminating chunk — the `TransferEncodingError`
    // live-streams.ts exists to prevent, with a crash behind it instead of a
    // scale-in. The stub THROWS, so the exit is observable and the ender having
    // run proves it ran first.
    const ender = vi.fn();
    registerLiveStream(ender);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const { exception } = handlers();

    expect(() => exception(new Error("boom"))).toThrow("process.exit");

    expect(ender).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(logs.errors()).toHaveLength(1);
  });
});
