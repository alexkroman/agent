// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

/**
 * The prebuilt page an agent with no `client.tsx` gets, and WHICH mount it uses.
 *
 * The two mounts are handed in as fakes rather than driven: what is asserted
 * here is the CHOICE, and both mounts have their own suites. The lookup is the
 * real `fetchClientConfig` over a stubbed `fetch`.
 *
 * The failure this exists to catch is silent in the direction that matters: a
 * workflow app mounted with `mountClient()` renders a start screen and then
 * opens a `/websocket` the server declines by design, so the symptom is a dead
 * page rather than an error — and it reproduces identically under `aai dev` and
 * in production, which is the only good news about it.
 */

import { describe, expect, test, vi } from "vitest";
import { bootDefaultClient, type DefaultClientMounts } from "./default-client.tsx";

/** Fake mounts, recording which one the boot chose. */
function fakeMounts() {
  return {
    mountClient: vi.fn<DefaultClientMounts["mountClient"]>(),
    mountPage: vi.fn<DefaultClientMounts["mountPage"]>(),
  };
}

/** Answer the client-config lookup with `config`, and boot against fake mounts. */
async function bootWith(config: unknown): Promise<ReturnType<typeof fakeMounts>> {
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
  const mounts = fakeMounts();
  await bootDefaultClient(mounts);
  return mounts;
}

describe("the prebuilt default client", () => {
  test("mounts the PAGE for an agent whose front door is static", async () => {
    const { mountPage, mountClient } = await bootWith({ name: "Link Digest", page: "static" });
    expect(mountPage).toHaveBeenCalledWith({ name: "Link Digest" });
    expect(mountClient).not.toHaveBeenCalled();
  });

  test("mounts the voice CLIENT for every other agent", async () => {
    const { mountPage, mountClient } = await bootWith({ name: "Support", page: "voice" });
    expect(mountClient).toHaveBeenCalledWith({ name: "Support" });
    expect(mountPage).not.toHaveBeenCalled();
  });

  test("names no agent when the agent named none, so the shell asks for itself", async () => {
    // `mountClient({ name })` treats an explicit name as final and skips its own
    // lookup — so passing `undefined` through would leave the header blank
    // forever rather than falling back on the shell's own request.
    const { mountClient } = await bootWith({ page: "voice" });
    expect(mountClient).toHaveBeenCalledWith({});
  });

  test("a failed lookup mounts the voice client — the front door it can always mount", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const mounts = fakeMounts();
    await bootDefaultClient(mounts);
    // `fetchClientConfig` degrades every failure to the agent default, which
    // names `page: "voice"`.
    expect(mounts.mountClient).toHaveBeenCalledWith({});
  });
});
