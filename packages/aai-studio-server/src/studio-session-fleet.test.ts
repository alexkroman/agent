// Copyright 2026 the AAI authors. MIT license.

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AdoptSessionParams, adoptPeerSession } from "./studio-session-adopt.ts";
import { createSessionFleet, soloFleet } from "./studio-session-fleet.ts";
import {
  createMemoryStudioSessionRegistry,
  type StudioSessionRecord,
} from "./studio-session-registry.ts";

const SCOPE = "scope";
const PROJECT = "proj";
const US = "replica-a";
const PEER = "replica-b";

const CLAIM = {
  chatUrl: "https://guest.example/studio/chat",
  chatToken: "chat-token",
  guestOrigin: "wss://guest.example",
  sandboxToken: "sandbox-token",
};

const PARAMS: AdoptSessionParams = {
  scope: SCOPE,
  project: PROJECT,
  files: {},
  apiKey: "caller-key",
  system: "s",
  model: "m",
  maxSteps: 4,
};

// Typed as the real peer install rather than cast in: the fleet's `adopt` seam
// IS `adoptPeerSession`, and a cast here stops reporting when its shape moves.
function setup(
  adopt = vi.fn<typeof adoptPeerSession>(async () => ({
    url: "https://peer/chat",
    token: "chat-token",
  })),
) {
  const registry = createMemoryStudioSessionRegistry();
  const fleet = createSessionFleet({ registry, replicaId: US, adopt });
  return { registry, fleet, adopt };
}

/** A row as another replica would have written it. */
const peerRow = (): StudioSessionRecord => ({ ...CLAIM, owner: PEER });

describe("soloFleet", () => {
  test("reports no peers and holds nothing", async () => {
    // The single-process default: every broker call must fall through to the
    // local map and a local spawn, exactly as before the registry existed.
    expect(await soloFleet.adopt(SCOPE, PROJECT, PARAMS)).toBeNull();
    expect(await soloFleet.heldByUs(SCOPE, PROJECT)).toBe(false);
    await expect(soloFleet.claim(SCOPE, PROJECT, CLAIM)).resolves.toBeUndefined();
    await expect(soloFleet.release(SCOPE, PROJECT)).resolves.toBeUndefined();
    expect(soloFleet.touch(SCOPE, PROJECT)).toBeUndefined();
  });
});

describe("createSessionFleet", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  test("claim stamps this replica as the owner", async () => {
    const { registry, fleet } = setup();
    await fleet.claim(SCOPE, PROJECT, CLAIM);
    expect(await registry.get(SCOPE, PROJECT)).toEqual({ ...CLAIM, owner: US });
  });

  test("claim swallows a registry failure — a duplicate beats a failed session", async () => {
    const registry = createMemoryStudioSessionRegistry();
    vi.spyOn(registry, "claim").mockRejectedValue(new Error("db down"));
    const fleet = createSessionFleet({ registry, replicaId: US });
    await expect(fleet.claim(SCOPE, PROJECT, CLAIM)).resolves.toBeUndefined();
  });

  test("a DELETED project is named as one, not as a peer-duplication risk", async () => {
    // `studio_sessions` has one foreign key, so 23503 has one cause: the workspace
    // cascaded away while this session was being brokered. Reporting it as "peers
    // may duplicate" describes a database we could not write to and misnames the
    // condition an operator is actually looking at.
    const registry = createMemoryStudioSessionRegistry();
    vi.spyOn(registry, "claim").mockRejectedValue(
      Object.assign(new Error('insert or update on table "studio_sessions" violates …'), {
        code: "23503",
      }),
    );
    const fleet = createSessionFleet({ registry, replicaId: US });
    await expect(fleet.claim(SCOPE, PROJECT, CLAIM)).resolves.toBeUndefined();
    const warned = vi.mocked(console.warn).mock.calls.map(([line]) => String(line));
    expect(warned).toContain("Studio session: project was deleted while it was being brokered");
    expect(warned).not.toContain("Studio session: registry claim failed; peers may duplicate");
  });

  test("adopt installs into a peer's guest and touches the lease", async () => {
    const { registry, fleet, adopt } = setup();
    await registry.claim(SCOPE, PROJECT, peerRow());
    const touched = vi.spyOn(registry, "touch");
    expect(await fleet.adopt(SCOPE, PROJECT, PARAMS)).toEqual({
      url: "https://peer/chat",
      token: "chat-token",
    });
    expect(adopt).toHaveBeenCalledWith(peerRow(), PARAMS);
    expect(touched).toHaveBeenCalledWith(SCOPE, PROJECT);
  });

  test("never adopts its OWN row — the local map already answered", async () => {
    const { registry, fleet, adopt } = setup();
    await registry.claim(SCOPE, PROJECT, { ...CLAIM, owner: US });
    expect(await fleet.adopt(SCOPE, PROJECT, PARAMS)).toBeNull();
    expect(adopt).not.toHaveBeenCalled();
  });

  test("adopt with no row resolves null", async () => {
    const { fleet, adopt } = setup();
    expect(await fleet.adopt(SCOPE, PROJECT, PARAMS)).toBeNull();
    expect(adopt).not.toHaveBeenCalled();
  });

  test("a failed install drops the stale row so the next call spawns", async () => {
    const { registry, fleet } = setup(vi.fn<typeof adoptPeerSession>(async () => null));
    await registry.claim(SCOPE, PROJECT, peerRow());
    expect(await fleet.adopt(SCOPE, PROJECT, PARAMS)).toBeNull();
    expect(await registry.get(SCOPE, PROJECT)).toBeNull();
  });

  test("a registry read failure reads as no peer, not as an error", async () => {
    const registry = createMemoryStudioSessionRegistry();
    vi.spyOn(registry, "get").mockRejectedValue(new Error("db down"));
    const fleet = createSessionFleet({ registry, replicaId: US });
    expect(await fleet.adopt(SCOPE, PROJECT, PARAMS)).toBeNull();
  });

  test("release drops only our own row", async () => {
    const { registry, fleet } = setup();
    await registry.claim(SCOPE, PROJECT, peerRow());
    await fleet.release(SCOPE, PROJECT);
    expect(await registry.get(SCOPE, PROJECT)).toEqual(peerRow());

    await registry.claim(SCOPE, PROJECT, { ...CLAIM, owner: US });
    await fleet.release(SCOPE, PROJECT);
    expect(await registry.get(SCOPE, PROJECT)).toBeNull();
  });

  test("touch extends the lease without awaiting", async () => {
    const { registry, fleet } = setup();
    const touched = vi.spyOn(registry, "touch");
    fleet.touch(SCOPE, PROJECT);
    expect(touched).toHaveBeenCalledWith(SCOPE, PROJECT);
  });

  test("heldByUs is true while we own a live row", async () => {
    const { registry, fleet } = setup();
    await registry.claim(SCOPE, PROJECT, { ...CLAIM, owner: US });
    expect(await fleet.heldByUs(SCOPE, PROJECT)).toBe(true);
  });

  test("heldByUs is false with no row, or when a peer took over", async () => {
    const { registry, fleet } = setup();
    expect(await fleet.heldByUs(SCOPE, PROJECT)).toBe(false);
    await registry.claim(SCOPE, PROJECT, peerRow());
    expect(await fleet.heldByUs(SCOPE, PROJECT)).toBe(false);
  });

  test("heldByUs answers true on a registry error — not evidence of idleness", async () => {
    // Evicting on a failed read would terminate a guest a peer may be
    // actively serving, since the owner holds the control socket.
    const registry = createMemoryStudioSessionRegistry();
    vi.spyOn(registry, "get").mockRejectedValue(new Error("db down"));
    const fleet = createSessionFleet({ registry, replicaId: US });
    expect(await fleet.heldByUs(SCOPE, PROJECT)).toBe(true);
  });
});
