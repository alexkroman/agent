// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

/**
 * The prebuilt page an agent with no `client.tsx` gets, and WHICH mount it uses.
 *
 * The whole module is a side effect at import, so each case resets the module
 * registry and imports it again — which is also what makes the two mounts worth
 * mocking rather than driving: what is asserted here is the CHOICE, and both
 * mounts have their own suites.
 *
 * The failure this exists to catch is silent in the direction that matters: a
 * workflow app mounted with `mountClient()` renders a start screen and then
 * opens a `/websocket` the server declines by design, so the symptom is a dead
 * page rather than an error — and it reproduces identically under `aai dev` and
 * in production, which is the only good news about it.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./define-client.tsx", () => ({ mountClient: vi.fn() }));
vi.mock("./page.tsx", () => ({ mountPage: vi.fn() }));

/** Answer the client-config lookup with `config`, and load the entry again. */
async function loadWith(config: unknown): Promise<void> {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(config), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ),
  );
  vi.resetModules();
  await import("./default-client.tsx");
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the prebuilt default client", () => {
  test("mounts the PAGE for an agent whose front door is static", async () => {
    await loadWith({ name: "Link Digest", page: "static" });
    const { mountPage } = await import("./page.tsx");
    const { mountClient } = await import("./define-client.tsx");
    await vi.waitFor(() =>
      expect(vi.mocked(mountPage)).toHaveBeenCalledWith({ name: "Link Digest" }),
    );
    expect(vi.mocked(mountClient)).not.toHaveBeenCalled();
  });

  test("mounts the voice CLIENT for every other agent", async () => {
    await loadWith({ name: "Support", page: "voice" });
    const { mountPage } = await import("./page.tsx");
    const { mountClient } = await import("./define-client.tsx");
    await vi.waitFor(() =>
      expect(vi.mocked(mountClient)).toHaveBeenCalledWith({ name: "Support" }),
    );
    expect(vi.mocked(mountPage)).not.toHaveBeenCalled();
  });

  test("names no agent when the agent named none, so the shell asks for itself", async () => {
    // `mountClient({ name })` treats an explicit name as final and skips its own
    // lookup — so passing `undefined` through would leave the header blank
    // forever rather than falling back on the shell's own request.
    await loadWith({ page: "voice" });
    const { mountClient } = await import("./define-client.tsx");
    await vi.waitFor(() => expect(vi.mocked(mountClient)).toHaveBeenCalledWith({}));
  });

  test("a failed lookup mounts the voice client — the front door it can always mount", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    vi.resetModules();
    await import("./default-client.tsx");
    const { mountClient } = await import("./define-client.tsx");
    // `fetchClientConfig` degrades every failure to the agent default, which
    // names `page: "voice"`.
    await vi.waitFor(() => expect(vi.mocked(mountClient)).toHaveBeenCalledWith({}));
  });
});
