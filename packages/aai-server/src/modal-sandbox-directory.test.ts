// Copyright 2026 the AAI authors. MIT license.
/**
 * The fleet-wide "is some replica already serving this deploy?" lookup, against
 * an injected {@link ModalSpawnContext} — no real Modal calls.
 *
 * Three of this module's four promises are about what it does when something
 * goes WRONG, which is what makes it worth a spec: it must never throw, because
 * a false miss costs one extra sandbox while a thrown lookup fails a broker call
 * that could have been served. So a miss, a control-plane failure and a sandbox
 * with no harness tunnel all have to arrive at the same `null`, and the only way
 * to tell those apart afterwards is the line it writes.
 *
 * The fourth is the mechanism itself: the sandbox NAME is the registration (see
 * `sandbox-directory.ts`), so the name it asks Modal about, version included, is
 * the whole reason two replicas cannot both spawn a guest for one deploy.
 */

import { describe, expect, test, vi } from "vitest";
import { GUEST_ROUTES, guestWsUrl } from "./guest-routes.ts";
import {
  GUEST_PORT,
  type ModalSandboxLike,
  type ModalSpawnContext,
  type ModalTunnelLike,
} from "./modal-context.ts";
import { createModalSandboxDirectory } from "./modal-sandbox-directory.ts";
import { agentSandboxName } from "./sandbox-directory.ts";
import { captureLogs } from "./test-utils.ts";

/** The tunnel Modal reports for a healthy guest. */
const GUEST_TUNNEL: ModalTunnelLike = { host: "tunnel.modal.test", port: 12_345 };

/**
 * A sandbox whose only working method is `tunnels()`.
 *
 * Every other member REJECTS rather than returning something plausible: this
 * module is documented as a pure READ of Modal's control plane, and a fake that
 * quietly tolerated an exec or a terminate would let that stop being true
 * without any spec noticing.
 */
function fakeGuestSandbox(tunnels: Record<number, ModalTunnelLike>): ModalSandboxLike & {
  exec: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  writeText: ReturnType<typeof vi.fn>;
} {
  const exec = vi.fn(() => Promise.reject(new Error("a directory lookup never execs")));
  const terminate = vi.fn(() => Promise.reject(new Error("a directory lookup never terminates")));
  const writeText = vi.fn(() => Promise.reject(new Error("a directory lookup never writes")));
  return {
    sandboxId: "sb-directory-test",
    waitUntilReady: () => Promise.reject(new Error("a directory lookup never waits")),
    exec,
    terminate,
    writeText,
    tunnels: () => Promise.resolve(tunnels),
    filesystem: { writeText },
  };
}

/** A context that answers one lookup, recording every name it was asked for. */
function ctxFor(
  answer: (name: string) => Promise<ModalSandboxLike | null>,
): ModalSpawnContext & { names: string[] } {
  const names: string[] = [];
  return {
    names,
    lookupGuestSandbox: (name) => {
      names.push(name);
      return answer(name);
    },
    createGuestSandbox: () => Promise.reject(new Error("a directory lookup never spawns")),
    prepareGuestImage: () => Promise.reject(new Error("a directory lookup never builds an image")),
  };
}

describe("createModalSandboxDirectory", () => {
  const logs = captureLogs();

  test("hands back the guest's session URL and origin when Modal holds the name", async () => {
    const sandbox = fakeGuestSandbox({ [GUEST_PORT]: GUEST_TUNNEL });
    const directory = createModalSandboxDirectory(ctxFor(() => Promise.resolve(sandbox)));

    const found = await directory.find("acme-intake", 7);

    // Composed from the same origin derivation and route constant the broker
    // uses, rather than restating `wss://host:port/session` — a peer's URL is
    // handed to a browser, so a second spelling here could agree with nothing.
    const origin = `wss://${GUEST_TUNNEL.host}:${GUEST_TUNNEL.port}`;
    expect(found).toEqual({
      sessionUrl: guestWsUrl(origin, GUEST_ROUTES.session),
      guestOrigin: origin,
    });
  });

  test("asks Modal about the name the whole mechanism is built on", async () => {
    // The name IS the registration: every replica computes the same one for the
    // same (slug, version), which is what stops two of them spawning a guest for
    // one deploy. Asserted against the pure generator rather than a literal.
    const ctx = ctxFor(() => Promise.resolve(null));
    await createModalSandboxDirectory(ctx).find("acme-intake", 7);

    expect(ctx.names).toEqual([agentSandboxName("acme-intake", 7)]);
  });

  test("a lookup is version-EXACT, so a blue-green handover cannot be confused", async () => {
    // `handoverSlot` boots the replacement while the old resident drains, so a
    // slug legitimately has two live sandboxes for minutes. A version-less name
    // would both collide and route clients at superseded code.
    const ctx = ctxFor(() => Promise.resolve(null));
    const directory = createModalSandboxDirectory(ctx);

    await directory.find("acme-intake", 7);
    await directory.find("acme-intake", 8);

    expect(new Set(ctx.names).size).toBe(2);
  });

  test("no live sandbox is a null answer and no log line", async () => {
    // The ordinary cold-broker case: the caller spawns, and there is nothing to
    // report — a line here would fire on every first session of every agent.
    const directory = createModalSandboxDirectory(ctxFor(() => Promise.resolve(null)));

    await expect(directory.find("acme-intake", 7)).resolves.toBeNull();
    expect(logs.all()).toEqual([]);
  });

  test("a control-plane failure reads as no sandbox, and says which name", async () => {
    // The failure direction that matters: a throw would fail a broker call that
    // spawning could have served. The line carries the name because the caller
    // has already reduced (slug, version) to it.
    const directory = createModalSandboxDirectory(
      ctxFor(() => Promise.reject(new Error("modal control plane unreachable"))),
    );

    await expect(directory.find("acme-intake", 7)).resolves.toBeNull();
    expect(logs.all()).toMatchObject([
      { level: "debug", ctx: { name: agentSandboxName("acme-intake", 7) } },
    ]);
  });

  test("a sandbox with no tunnel on the harness port is no sandbox either", async () => {
    // A running sandbox whose harness port was never tunnelled cannot serve a
    // session, so `guestOrigin` throwing is the same "no sandbox" answer — plus
    // a line, since unlike a plain miss this one is a sandbox nobody can reach.
    const directory = createModalSandboxDirectory(
      ctxFor(() => Promise.resolve(fakeGuestSandbox({ 9999: GUEST_TUNNEL }))),
    );

    await expect(directory.find("acme-intake", 7)).resolves.toBeNull();
    expect(logs.all().map((line) => line.level)).toEqual(["debug"]);
  });

  test("finding a peer never touches the sandbox it found", async () => {
    // A peer routes clients to the guest; it does not manage it. The per-sandbox
    // bearer that gates `/manage/*` stays with whoever spawned it, so there is
    // nothing here a lookup could legitimately call.
    const sandbox = fakeGuestSandbox({ [GUEST_PORT]: GUEST_TUNNEL });
    await createModalSandboxDirectory(ctxFor(() => Promise.resolve(sandbox))).find("s", 1);

    expect(sandbox.exec).not.toHaveBeenCalled();
    expect(sandbox.terminate).not.toHaveBeenCalled();
    expect(sandbox.writeText).not.toHaveBeenCalled();
  });
});
