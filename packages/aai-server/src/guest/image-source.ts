// Copyright 2026 the AAI authors. MIT license.
/**
 * Where a guest sandbox's image comes from: an OCI REGISTRY.
 *
 * The image is the one `packages/aai-server/guest-image.Dockerfile` builds
 * (`pnpm build:guest-image`, published by `ship.yml`'s image job), so every
 * backend pulls one reference. `GUEST_IMAGE_REGISTRY` names the registry and
 * is REQUIRED on the Modal backend: there is no in-process image build to fall
 * back to, and a spawn with no registry fails at once naming the variable.
 *
 * ## The TAG
 *
 * The pull reference is `<registry>/<tag>`, where the tag is
 * `localHarnessImageTag`'s `aai-guest-harness:<sha16 of (base image, harness
 * code, toolchain)>`. `agents.harness_image_tag` holds tags recorded by earlier
 * deploys, and `harnessImageTag`'s own doc warns that any change to the hashed
 * byte stream makes every existing pin resolve to nothing; the registry PREFIX
 * is not part of that stream.
 *
 * ## What a missing image looks like
 *
 * `fromRegistry` is lazy — it hands back a handle without pulling — so an image
 * that was never published surfaces as a failure at sandbox CREATE, not here.
 * That is why the registry is logged at boot: "which image am I pulling, and
 * from where" has to be answerable from one line rather than inferred from the
 * shape of a later pull error. Same argument as `describeSandboxBackend`'s
 * reason string.
 *
 * The boot line is not sufficient on its own, because what Modal reports for a
 * missing manifest is `Image build for im-<id> failed with the exception:` and
 * then NOTHING — it sends no exception text for a `skopeo` pull failure, so the
 * one string a reader gets names no tag, no reference and no remedy. Every pull
 * reference is therefore logged where it is still known, once per tag.
 */

import type { Image } from "modal";
import { createLogger } from "../logger.ts";
import { localHarnessImageTag } from "../modal/harness-image.ts";

const log = createLogger("modal.guest-image");

/**
 * The slice of `ModalClient` an image source actually touches.
 *
 * A structural type rather than the client itself, so a test builds one by hand
 * instead of laundering a fake through `as unknown as ModalClient` — the cast
 * that also stops reporting the moment the real type grows a field. The real
 * client satisfies this structurally (`fromRegistry`'s optional `Secret`
 * parameter does not affect assignability).
 *
 * It is generic in the IMAGE because nothing here ever inspects one — an image
 * is opaque, produced by a lookup and handed to `sandboxes.create`. A fake can
 * therefore be any type at all, which is what removes the cast rather than
 * merely hiding it: `Image` is a class, so a structural stand-in for it can only
 * be spelled `as unknown as Image`, and that cast stops reporting the moment
 * the real class grows a member the code starts using.
 */
export type GuestImageClient<TImage = Image> = {
  images: {
    fromRegistry(tag: string): TImage;
  };
};

/** Env var naming the registry guest images are pulled from. */
export const GUEST_IMAGE_REGISTRY_ENV = "GUEST_IMAGE_REGISTRY";

/**
 * The registry to pull guest images from, or `undefined` when none is set.
 *
 * A malformed value throws rather than being coerced: it would otherwise
 * surface as an unresolvable pull at the first spawn, which reads as "the image
 * was never published" and sends the reader looking in the wrong place
 * entirely. Same policy as an unknown `SANDBOX_BACKEND`.
 */
export function guestImageRegistry(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env[GUEST_IMAGE_REGISTRY_ENV]?.trim();
  if (!raw) return undefined;
  // Trailing slashes are the one forgiving case — `guestImageRef` joins with
  // one, and `ghcr.io/owner/` is what a copied-from-a-URL value looks like.
  const registry = raw.replace(/\/+$/, "");
  if (/\s/.test(registry) || registry.endsWith(":") || registry.includes("//")) {
    throw new Error(
      `${GUEST_IMAGE_REGISTRY_ENV} is malformed: ${JSON.stringify(raw)} — expected a registry ` +
        'host and namespace with no tag, e.g. "ghcr.io/owner"',
    );
  }
  return registry;
}

/**
 * The pull reference for a harness image tag.
 *
 * The tag already carries its own `name:digest` shape, so this is a join and
 * nothing more — see the module doc on why the prefix must stay outside the
 * hashed byte stream.
 */
export function guestImageRef(registry: string, tag: string): string {
  return `${registry}/${tag}`;
}

/** How a spawn turns a harness build, or a pinned tag, into an Image. */
export type GuestImageSource<TImage = Image> = {
  /** One boot-log line: which source, and where it reads from. */
  reason: string;
  /**
   * The image for THIS harness build. Structurally a `HarnessImageResolver`
   * when the image is Modal's.
   */
  current: (code: string) => Promise<TImage>;
  /** The image a deploy pinned, by the tag recorded on its agents row. */
  byTag: (tag: string) => Promise<TImage>;
  /**
   * Compute the current tag ahead of any spawn, so the first session does not
   * pay the synchronous SHA-256 over the harness. There is no image to build:
   * `fromRegistry` is lazy and Modal pulls at create time.
   */
  prepare: (code: string) => Promise<void>;
};

/**
 * Memoize `localHarnessImageTag` per harness build.
 *
 * The tag's inputs are invariant per process (the harness code is itself
 * memoized; the specs and lockfile are files on disk), and computing it means
 * SHA-256 over the ~17 MB bundle — 13-15ms, synchronous, so it stalls the event
 * loop — plus a handful of `readFileSync`+`JSON.parse`. On every cold session
 * and every studio broker call.
 */
function createHarnessTagger(baseTag: string): (code: string) => string {
  const memo = new Map<string, string>();
  return (code) => {
    let tag = memo.get(code);
    if (tag === undefined) {
      tag = localHarnessImageTag(baseTag, code);
      memo.set(code, tag);
    }
    return tag;
  };
}

/**
 * The registry source. Narrow by construction — it needs a registry, a base tag
 * and the image lookup, and nothing else, which is what makes it testable
 * without a Modal client.
 */
export function registryImageSource<TImage>(deps: {
  client: GuestImageClient<TImage>;
  baseTag: string;
  registry: string;
}): GuestImageSource<TImage> {
  const { client, baseTag, registry } = deps;
  const tagOf = createHarnessTagger(baseTag);
  /**
   * Tags whose reference has already been logged — for the current image and
   * for a pin alike, since a `manifest unknown` arrives from Modal with no tag
   * attached and this is the only place the reference is knowable. Once per
   * distinct tag rather than once per spawn: a per-spawn line on the cold-start
   * path would be noise that buries itself.
   */
  const logged = new Set<string>();
  // `fromRegistry` is synchronous and lazy; a public registry needs no Secret,
  // which is why none is threaded through. Do not add the parameter until a
  // private registry actually uses it.
  const pull = (tag: string): Promise<TImage> => {
    const ref = guestImageRef(registry, tag);
    if (!logged.has(tag)) {
      logged.add(tag);
      log.info("pulling guest image from the registry", { tag, ref });
    }
    return Promise.resolve(client.images.fromRegistry(ref));
  };
  return {
    reason: `${GUEST_IMAGE_REGISTRY_ENV}=${registry}`,
    current: (code) => pull(tagOf(code)),
    byTag: pull,
    prepare: async (code) => {
      tagOf(code);
    },
  };
}

/**
 * The image source this process uses — the registry `GUEST_IMAGE_REGISTRY`
 * names. Unset is an ERROR naming the variable rather than a lazy failure at
 * the first pull, which would read as "the image was never published". The
 * returned `reason` is what the boot log prints.
 */
export function createGuestImageSource<TImage>(deps: {
  client: GuestImageClient<TImage>;
  baseTag: string;
  env?: NodeJS.ProcessEnv;
}): GuestImageSource<TImage> {
  const { client, baseTag, env = process.env } = deps;
  const registry = guestImageRegistry(env);
  if (registry === undefined) {
    throw new Error(
      `${GUEST_IMAGE_REGISTRY_ENV} is not set — Modal guest sandboxes pull their image from a ` +
        'registry (e.g. "ghcr.io/owner"); publish one with `pnpm build:guest-image` or ' +
        "dispatch ship.yml",
    );
  }
  return registryImageSource({ client, baseTag, registry });
}
