// Copyright 2026 the AAI authors. MIT license.
/**
 * The image-source policy: a registry, required, at exactly the tag a deploy
 * records.
 *
 * Every fake here is built from `GuestImageClient`, the narrow structural type
 * the module takes — so nothing is laundered through `as unknown as
 * ModalClient`.
 */

import { describe, expect, test } from "vitest";
import { captureLogs } from "../_logger-test-utils.ts";
import { localHarnessImageTag } from "../modal/harness-image.ts";
import {
  createGuestImageSource,
  GUEST_IMAGE_REGISTRY_ENV,
  type GuestImageClient,
  guestImageRef,
  guestImageRegistry,
  registryImageSource,
} from "./image-source.ts";

const BASE_TAG = "node:26-slim";

/**
 * The image type these fakes use. Nothing in the module inspects an image — it
 * is produced by a lookup and handed to Modal — so the seam is generic in it and
 * a fake needs no cast at all.
 */
type FakeImage = { readonly ref: string };

/** A client that records every lookup. */
function fakeClient(): { client: GuestImageClient<FakeImage>; fromRegistry: string[] } {
  const fromRegistry: string[] = [];
  return {
    fromRegistry,
    client: {
      images: {
        fromRegistry: (tag) => {
          fromRegistry.push(tag);
          return { ref: tag };
        },
      },
    },
  };
}

describe("guestImageRegistry", () => {
  test("absent or blank means no registry", () => {
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
    // exception, so this line is the only place the reference is named.
    const { client } = fakeClient();
    const source = registryImageSource({ client, baseTag: BASE_TAG, registry: "ghcr.io/owner" });
    const code = "export const harness = 1;\n";

    await source.current(code);

    const line = logs.all().find((l) => l.msg.includes("pulling guest image"));
    expect(line?.level).toBe("info");
    // The REFERENCE, not just the tag: the registry half is part of the answer.
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

    expect(logs.all().filter((l) => l.msg.includes("pulling guest image"))).toHaveLength(2);
  });

  test("prepare pulls nothing — `fromRegistry` is lazy, so there is no image to build", async () => {
    const { client, fromRegistry } = fakeClient();
    const source = registryImageSource({ client, baseTag: BASE_TAG, registry: "r" });

    await expect(source.prepare("code")).resolves.toBeUndefined();

    expect(fromRegistry).toEqual([]);
  });
});

describe("createGuestImageSource", () => {
  test("an unset registry fails naming the variable — there is no other source", () => {
    const { client } = fakeClient();
    expect(() => createGuestImageSource({ client, baseTag: BASE_TAG, env: {} })).toThrow(
      GUEST_IMAGE_REGISTRY_ENV,
    );
  });

  test("a set registry is the source", () => {
    const { client } = fakeClient();
    const source = createGuestImageSource({
      client,
      baseTag: BASE_TAG,
      env: { [GUEST_IMAGE_REGISTRY_ENV]: "ghcr.io/owner" },
    });
    expect(source.reason).toContain("ghcr.io/owner");
  });

  test("a malformed registry fails at BOOT rather than at the first spawn", () => {
    const { client } = fakeClient();
    expect(() =>
      createGuestImageSource({
        client,
        baseTag: BASE_TAG,
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
