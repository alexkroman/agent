// Copyright 2026 the AAI authors. MIT license.
/**
 * The image-source policy, and the one property that makes it safe to switch:
 * a tag recorded under one source resolves under the other.
 *
 * That property was ASSERTED for one release and did not hold — the same tag
 * under both sources names one triple and two different published artifacts —
 * so the specs below now pin the resolution ORDER that delivers it, and the
 * fake can miss.
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
import { captureLogs } from "./test-utils.ts";

const BASE_TAG = "node:26-slim";

/**
 * The image type these fakes use. Nothing in the module inspects an image — it
 * is produced by a lookup and handed to Modal — so the seam is generic in it and
 * a fake needs no cast at all.
 */
type FakeImage = { readonly ref: string };

/**
 * A client that records every lookup.
 *
 * `modalHolds` is what Modal's own image registry contains, and it defaults to
 * NOTHING — the post-migration steady state, where every pin is a registry pin.
 * A `fromName` that always resolved would make the pre-flip-pin path the one
 * every spec exercised by accident.
 */
function fakeClient(modalHolds: readonly string[] = []): {
  client: GuestImageClient<FakeImage>;
  fromRegistry: string[];
  fromName: string[];
} {
  const fromRegistry: string[] = [];
  const fromName: string[] = [];
  const held = new Set(modalHolds);
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
          // Modal's SDK throws NotFoundError for a name it does not hold; the
          // MESSAGE is not what the code keys on, so a plain Error is faithful.
          return held.has(tag)
            ? Promise.resolve({ ref: tag })
            : Promise.reject(new Error(`Image '${tag}' not found`));
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
  const logs = captureLogs();

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

  test("resolves a PINNED tag by prefixing it, and never by rehashing", async () => {
    const { client, fromRegistry } = fakeClient();
    const source = registryImageSource({ client, baseTag: BASE_TAG, registry: "ghcr.io/owner" });

    await source.byTag("aai-guest-harness:0123456789abcdef");

    expect(fromRegistry).toEqual(["ghcr.io/owner/aai-guest-harness:0123456789abcdef"]);
    // The REFERENCE is logged where it is still known. Modal reports a missing
    // manifest as `Image build for im-<id> failed with the exception:` and then
    // nothing at all, so without this line a failed pull names no image.
    expect(
      logs
        .all()
        .map((l) => JSON.stringify(l.ctx))
        .join("\n"),
    ).toContain("ghcr.io/owner/aai-guest-harness:0123456789abcdef");
  });

  test("a pin Modal still holds resolves from MODAL, not the registry", async () => {
    // The production bug this exists for: flipping GUEST_IMAGE_REGISTRY on
    // orphaned every pin an earlier deploy had recorded, because a snapshot-era
    // pin was published to Modal and to nowhere else. Five of them, one per
    // agent deployed before the flip, spawned as `503 agent unavailable` behind
    // a `manifest unknown` that named no tag.
    const pin = "aai-guest-harness:72f3243f3eea1189";
    const { client, fromRegistry, fromName } = fakeClient([pin]);
    const source = registryImageSource({ client, baseTag: BASE_TAG, registry: "ghcr.io/owner" });

    await expect(source.byTag(pin)).resolves.toEqual({ ref: pin });

    expect(fromName).toEqual([pin]);
    // Not merely "resolved" — resolved WITHOUT a registry pull, since the
    // registry handle is lazy and would have failed at sandbox create instead.
    expect(fromRegistry).toEqual([]);
  });

  test("the CURRENT harness never consults Modal — nothing publishes there", async () => {
    // Ordering matters in one direction only: a Modal miss is one gRPC call,
    // a registry miss is unobservable until the pull. So the pinned path may
    // ask Modal first and the current path may not — it would be a guaranteed
    // miss on every cold spawn.
    const { client, fromName } = fakeClient();
    const source = registryImageSource({ client, baseTag: BASE_TAG, registry: "ghcr.io/owner" });

    await source.current("export const harness = 1;\n");

    expect(fromName).toEqual([]);
  });

  test("a pin is looked up once per process, however many spawns ask", async () => {
    const pin = "aai-guest-harness:0123456789abcdef";
    const { client, fromName, fromRegistry } = fakeClient();
    const source = registryImageSource({ client, baseTag: BASE_TAG, registry: "ghcr.io/owner" });

    await Promise.all([source.byTag(pin), source.byTag(pin)]);
    await source.byTag(pin);

    // The Modal probe is the cost this memo exists to bound; it buys the
    // portability above without paying a round trip per spawn.
    expect(fromName).toEqual([pin]);
    expect(fromRegistry).toEqual([`ghcr.io/owner/${pin}`]);
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

  test("logs the CURRENT pull reference — the miss that named nothing", async () => {
    // `fromRegistry` is lazy, so an unpublished image fails two layers down at
    // sandbox CREATE, and Modal reports a skopeo manifest miss as
    // `Image build for im-<id> failed with the exception:` with an EMPTY
    // exception. The module doc promised "every pull reference is logged where
    // it is still known"; `resolvePinAcrossSources` kept that for PINS only, so
    // a studio session — which carries no pin — logged nothing at all, and the
    // reference had to be read out of Modal's own build log.
    const { client } = fakeClient();
    const source = registryImageSource({ client, baseTag: BASE_TAG, registry: "ghcr.io/owner" });
    const code = "export const harness = 1;\n";

    await source.current(code);

    const line = logs.all().find((l) => l.msg.includes("current guest image"));
    expect(line?.level).toBe("info");
    // The REFERENCE, not just the tag: the registry half is what tells an
    // operator which of the two sources they are looking at.
    expect(line?.ctx?.ref).toBe(`ghcr.io/owner/${localHarnessImageTag(BASE_TAG, code)}`);
  });

  test("logs it once per harness build, not once per spawn", async () => {
    // A line per cold spawn on the hot path buries itself. The tag changes only
    // with the harness build, so once per distinct tag is the whole signal.
    const { client } = fakeClient();
    const source = registryImageSource({ client, baseTag: BASE_TAG, registry: "ghcr.io/owner" });

    await source.current("a");
    await source.current("a");
    await source.current("b");

    expect(logs.all().filter((l) => l.msg.includes("current guest image"))).toHaveLength(2);
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
