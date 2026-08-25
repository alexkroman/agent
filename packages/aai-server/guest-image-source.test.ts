// Copyright 2026 the AAI authors. MIT license.
/**
 * The image-source policy, and the one property that makes it safe to switch:
 * a tag recorded under one source resolves under the other.
 *
 * Every fake here is built from `GuestImageClient`, the narrow structural type
 * the module takes — so nothing is laundered through `as unknown as
 * ModalClient`, which is what the sibling `modal-harness-image.test.ts` needs
 * and what its three baselined escape hatches are.
 */

import { describe, expect, test, vi } from "vitest";
import {
  createGuestImageSource,
  GUEST_IMAGE_REGISTRY_ENV,
  type GuestImageClient,
  type GuestImageSource,
  guestImageRef,
  guestImageRegistry,
  registryImageSource,
} from "./guest-image-source.ts";
import { localHarnessImageTag } from "./modal-harness-image.ts";

const BASE_TAG = "node:26-slim";

/**
 * The image type these fakes use. Nothing in the module inspects an image — it
 * is produced by a lookup and handed to Modal — so the seam is generic in it and
 * a fake needs no cast at all.
 */
type FakeImage = { readonly ref: string };

/** A client that records every lookup. */
function fakeClient(): {
  client: GuestImageClient<FakeImage>;
  fromRegistry: string[];
  fromName: string[];
} {
  const fromRegistry: string[] = [];
  const fromName: string[] = [];
  return {
    fromRegistry,
    fromName,
    client: {
      images: {
        fromRegistry: (tag) => {
          fromRegistry.push(tag);
          return { ref: tag };
        },
        fromName: (tag) => {
          fromName.push(tag);
          return Promise.resolve({ ref: tag });
        },
      },
    },
  };
}

/** A stand-in snapshot source, so the selector can be tested on its own. */
function fakeSnapshot(): GuestImageSource<FakeImage> {
  return {
    kind: "snapshot",
    reason: "fake",
    current: (code) => Promise.resolve({ ref: code }),
    byTag: (tag) => Promise.resolve({ ref: tag }),
    prepare: () => Promise.resolve(),
  };
}

describe("guestImageRegistry", () => {
  test("absent or blank means the snapshot path", () => {
    expect(guestImageRegistry({})).toBeUndefined();
    expect(guestImageRegistry({ [GUEST_IMAGE_REGISTRY_ENV]: "" })).toBeUndefined();
    expect(guestImageRegistry({ [GUEST_IMAGE_REGISTRY_ENV]: "   " })).toBeUndefined();
  });

  test("trailing slashes are forgiven — that is what a copied URL looks like", () => {
    expect(guestImageRegistry({ [GUEST_IMAGE_REGISTRY_ENV]: "ghcr.io/owner/" })).toBe(
      "ghcr.io/owner",
    );
    expect(guestImageRegistry({ [GUEST_IMAGE_REGISTRY_ENV]: " ghcr.io/owner// " })).toBe(
      "ghcr.io/owner",
    );
  });

  test.each([
    ["a tag was included", "ghcr.io/owner:"],
    ["it has whitespace", "ghcr.io/ owner"],
    ["it is a URL", "https://ghcr.io/owner"],
  ])("throws when %s", (_why, value) => {
    // Coercing would surface as an unresolvable pull at the first spawn, which
    // reads as "the image was never published" and misdirects the reader.
    expect(() => guestImageRegistry({ [GUEST_IMAGE_REGISTRY_ENV]: value })).toThrow(
      GUEST_IMAGE_REGISTRY_ENV,
    );
  });
});

describe("registryImageSource", () => {
  test("pulls the CURRENT harness at exactly the tag a deploy would record", () => {
    // The property that makes the switch safe: `agents.harness_image_tag` holds
    // tags computed by `localHarnessImageTag`, and the registry source must
    // resolve that same string — a registry PREFIX is not part of the hashed
    // byte stream. If this ever diverges, every existing pin resolves to
    // nothing and every already-deployed agent fails to spawn.
    const { client, fromRegistry } = fakeClient();
    const source = registryImageSource({ client, baseTag: BASE_TAG, registry: "ghcr.io/owner" });
    const code = "export const harness = 1;\n";

    void source.current(code);

    expect(fromRegistry).toEqual([`ghcr.io/owner/${localHarnessImageTag(BASE_TAG, code)}`]);
  });

  test("resolves a PINNED tag by prefixing it, and never by rehashing", () => {
    const { client, fromRegistry, fromName } = fakeClient();
    const source = registryImageSource({ client, baseTag: BASE_TAG, registry: "ghcr.io/owner" });

    void source.byTag("aai-guest-harness:0123456789abcdef");

    expect(fromRegistry).toEqual(["ghcr.io/owner/aai-guest-harness:0123456789abcdef"]);
    // Modal's own image registry is not consulted on this path at all.
    expect(fromName).toEqual([]);
  });

  test("computes the tag once per harness build", () => {
    // SHA-256 over the ~17 MB bundle is 13-15ms and SYNCHRONOUS, so an
    // unmemoized tag stalls the event loop on every cold session.
    const { client, fromRegistry } = fakeClient();
    const source = registryImageSource({ client, baseTag: BASE_TAG, registry: "r" });
    const code = "export const harness = 2;\n";

    void source.current(code);
    void source.current(code);

    expect(fromRegistry[0]).toBe(fromRegistry[1]);
    expect(fromRegistry).toHaveLength(2);
  });

  test("prepare is a declared no-op — there is nothing to prewarm", async () => {
    const { client, fromRegistry, fromName } = fakeClient();
    const source = registryImageSource({ client, baseTag: BASE_TAG, registry: "r" });

    await expect(source.prepare("code")).resolves.toBeUndefined();

    expect(fromRegistry).toEqual([]);
    expect(fromName).toEqual([]);
  });
});

describe("createGuestImageSource selects on the declaration", () => {
  test("unset env keeps the snapshot path, and does not construct it twice", () => {
    const { client } = fakeClient();
    const snapshot = vi.fn(fakeSnapshot);

    const source = createGuestImageSource({ client, baseTag: BASE_TAG, snapshot, env: {} });

    expect(source.kind).toBe("snapshot");
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  test("a set registry builds NONE of the snapshot machinery", () => {
    // The thunk is why: constructing the snapshot resolver on the registry path
    // would keep the legacy builder alive in a process that must never use it.
    const { client } = fakeClient();
    const snapshot = vi.fn(fakeSnapshot);

    const source = createGuestImageSource({
      client,
      baseTag: BASE_TAG,
      snapshot,
      env: { [GUEST_IMAGE_REGISTRY_ENV]: "ghcr.io/owner" },
    });

    expect(source.kind).toBe("registry");
    expect(source.reason).toContain("ghcr.io/owner");
    expect(snapshot).not.toHaveBeenCalled();
  });

  test("a malformed registry fails at BOOT rather than at the first spawn", () => {
    const { client } = fakeClient();
    expect(() =>
      createGuestImageSource({
        client,
        baseTag: BASE_TAG,
        snapshot: fakeSnapshot,
        env: { [GUEST_IMAGE_REGISTRY_ENV]: "ghcr.io/owner:" },
      }),
    ).toThrow(GUEST_IMAGE_REGISTRY_ENV);
  });
});

describe("guestImageRef", () => {
  test("joins with a single slash", () => {
    expect(guestImageRef("ghcr.io/owner", "aai-guest-harness:abc")).toBe(
      "ghcr.io/owner/aai-guest-harness:abc",
    );
  });
});
