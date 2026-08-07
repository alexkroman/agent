// Copyright 2026 the AAI authors. MIT license.
/**
 * Tests for the shared Modal context (modal-context.ts) — the two pure
 * translations every spawn path funnels through before it reaches Modal.
 * The spawn flows themselves live in modal-sandbox.test.ts and
 * modal-agent-sandbox.test.ts; env-derived limit parsing in
 * modal-sandbox-env.test.ts.
 */

import { AlreadyExistsError, type Image } from "modal";
import { describe, expect, it, vi } from "vitest";
import { resolveSpawnImage, translateCreateError } from "./modal-context.ts";
import { SandboxNameTakenError } from "./sandbox-directory.ts";

/** A stand-in for a Modal `Image`, identified only by tag. */
function fakeImage(tag: string): Image {
  return { tag } as unknown as Image;
}

describe("translateCreateError", () => {
  it("turns Modal's duplicate-name refusal into a routable race loss", () => {
    // The whole fleet-wide-uniqueness design rests on this: the name is what
    // stops two replicas serving one deploy, and the broker turns this error
    // into "go back to the directory and use the winner". Without the
    // translation the create just fails, and the peer is never found.
    const translated = translateCreateError(new AlreadyExistsError("taken"), "agent-abc-v1");
    expect(translated).toBeInstanceOf(SandboxNameTakenError);
    expect((translated as SandboxNameTakenError).name).toBe("SandboxNameTakenError");
    expect((translated as Error).cause).toBeInstanceOf(AlreadyExistsError);
  });

  it("leaves every other failure exactly as it was", () => {
    const boom = new Error("modal is down");
    expect(translateCreateError(boom, "agent-abc-v1")).toBe(boom);
  });

  it("does not translate an UNNAMED create — it has no race to lose", () => {
    const dup = new AlreadyExistsError("taken");
    expect(translateCreateError(dup, undefined)).toBe(dup);
  });
});

describe("resolveSpawnImage", () => {
  const current = fakeImage("current");
  const pinned = fakeImage("pinned");

  it("uses the deploy's pin, without building the current image", async () => {
    // Per-deploy environment pinning: a platform upgrade must not change the
    // image under an already-deployed bundle.
    const built = vi.fn(() => Promise.resolve(current));
    const image = await resolveSpawnImage({
      imageTag: "aai-guest-harness:abc",
      fromName: () => Promise.resolve(pinned),
      current: built,
      env: {},
    });
    expect(image).toBe(pinned);
    expect(built).not.toHaveBeenCalled();
  });

  it("builds the current image when there is no pin", async () => {
    const image = await resolveSpawnImage({
      imageTag: undefined,
      fromName: () => Promise.reject(new Error("must not be asked")),
      current: () => Promise.resolve(current),
      env: {},
    });
    expect(image).toBe(current);
  });

  it("fails LOUDLY on an unresolvable pin rather than substituting", async () => {
    // Silently falling back is the untested-environment drift that pinning
    // exists to prevent — and it would be invisible until the agent
    // misbehaved. The message has to name the two ways out.
    const built = vi.fn(() => Promise.resolve(current));
    await expect(
      resolveSpawnImage({
        imageTag: "aai-guest-harness:gone",
        fromName: () => Promise.reject(new Error("404 no such image")),
        current: built,
        env: {},
      }),
    ).rejects.toThrow(/pinned harness image aai-guest-harness:gone is unresolvable/);
    expect(built).not.toHaveBeenCalled();
  });

  it("honours the operator kill switch for a registry loss", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const image = await resolveSpawnImage({
      imageTag: "aai-guest-harness:gone",
      fromName: () => Promise.reject(new Error("404")),
      current: () => Promise.resolve(current),
      env: { SANDBOX_IGNORE_IMAGE_PINS: "1" },
    });
    // Deliberately loud: the operator has traded environment pinning away.
    expect(image).toBe(current);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("SANDBOX_IGNORE_IMAGE_PINS"), {
      imageTag: "aai-guest-harness:gone",
    });
  });
});
