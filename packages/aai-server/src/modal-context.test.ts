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
import { resolveSpawnImage, translateCreateError, translateSpawnFailure } from "./modal-context.ts";
import { SandboxNameTakenError } from "./sandbox-directory.ts";
import { SandboxUnavailableError } from "./sandbox-errors.ts";
import { captureLogs } from "./test-utils.ts";

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

describe("translateSpawnFailure", () => {
  // Only the TRANSLATION is covered here, not its wiring: `createGuestSandbox`
  // is built inside `buildContext`, which constructs a real Modal client and
  // takes no injection seam, so the `catch` that calls this is unreachable from
  // a unit test. Same limitation as `translateCreateError` above and for the
  // same reason — worth knowing rather than assuming, since a call site that
  // stopped calling this would restore the 500 with every test still green.
  it("turns an image-pull failure into the retryable 503 taxonomy", () => {
    // The production shape: Modal answers a skopeo manifest miss with
    // `Image build for im-<id> failed with the exception:` and no exception
    // text. Untranslated it reached the studio route as a bare Error and was
    // answered `500 Internal server error`, which the client cannot tell from
    // "this project is broken".
    const err = translateSpawnFailure(
      new Error("Image build for im-1QEtdKQbUNtElIneTbMDj6 failed with the exception:"),
    );

    expect(err).toBeInstanceOf(SandboxUnavailableError);
    // The technical message survives for the log; only the WIRE body is
    // authored elsewhere.
    expect((err as Error).message).toContain("Image build for im-");
    expect(((err as Error).cause as Error).message).toContain("failed with the exception");
  });

  it("passes a name-taken error through — it is a routing signal, not an answer", () => {
    // `awaitBrokeredUrl` catches this to return to the sandbox directory and
    // route to the peer that won. Wrapped, it would become a 503 and
    // reintroduce the duplicate spawn the name exists to prevent.
    const taken = new SandboxNameTakenError("agent-abc-v1");

    expect(translateSpawnFailure(taken)).toBe(taken);
  });

  it("does not double-wrap one it already produced", () => {
    const already = new SandboxUnavailableError("Modal sandbox spawn failed: nope");

    expect(translateSpawnFailure(already)).toBe(already);
  });
});

describe("resolveSpawnImage", () => {
  const logs = captureLogs();

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
    const image = await resolveSpawnImage({
      imageTag: "aai-guest-harness:gone",
      fromName: () => Promise.reject(new Error("404")),
      current: () => Promise.resolve(current),
      env: { SANDBOX_IGNORE_IMAGE_PINS: "1" },
    });
    // Deliberately loud: the operator has traded environment pinning away.
    expect(image).toBe(current);
    expect(logs.all()).toContainEqual({
      level: "warn",
      msg: expect.stringContaining("SANDBOX_IGNORE_IMAGE_PINS"),
      ctx: { imageTag: "aai-guest-harness:gone" },
    });
  });
});
