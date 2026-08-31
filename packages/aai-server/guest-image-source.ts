// Copyright 2026 the AAI authors. MIT license.
/**
 * Where a guest sandbox's image comes from — a REGISTRY, or the legacy Modal
 * snapshot built in-process.
 *
 * ## Two sources, and why both exist for now
 *
 * | Source     | The image is                          | Selected by                      |
 * | ---------- | ------------------------------------- | -------------------------------- |
 * | `registry` | pulled from an OCI registry           | `GUEST_IMAGE_REGISTRY` is set     |
 * | `snapshot` | BUILT here, then published to Modal   | the default                      |
 *
 * The snapshot path is the one `modal-harness-image.ts` implements: system
 * packages and toolchain as `dockerfileCommands` layers, then a throwaway
 * sandbox that writes the ~17 MB harness, warms its compile cache, and gets
 * `snapshotFilesystem()`'d and published. It works, and it produces an image
 * NOTHING OUTSIDE MODAL CAN RESOLVE — which is why a local backend could never
 * run production's guest environment, and why the previous local-container
 * attempt had to grow a second toolchain delivery mechanism to try (see "Two
 * tiers, deliberately" in `sandbox-backend.ts`).
 *
 * The registry path pulls the image `packages/aai-server/guest-image.Dockerfile`
 * builds — the same recipe, as a plain OCI image — so every backend can pull
 * one reference. It is opt-in rather than the default on purpose: nothing
 * publishes those images until the release workflow has run once, and a default
 * that pulls a tag that does not exist yet turns a deploy into a total sandbox
 * outage. Flipping the default (and deleting the snapshot half, which is most of
 * `modal-harness-image.ts`) is the follow-up, once images exist for real.
 *
 * ## The TAG is unchanged, deliberately
 *
 * Both sources key on exactly the same string — `localHarnessImageTag`'s
 * `aai-guest-harness:<sha16 of (base image, harness code, toolchain)>` — and the
 * registry source only prepends a registry to it. `agents.harness_image_tag`
 * holds tags recorded by earlier deploys, and `harnessImageTag`'s own doc warns
 * that any change to the hashed byte stream makes every existing pin resolve to
 * nothing; a registry PREFIX is not part of that stream.
 *
 * **That is not enough to make a pin portable, and this paragraph used to claim
 * it was** ("a pin recorded under one source resolves under the other"). The
 * same tag under both sources names the same TRIPLE and not the same published
 * bytes — each source publishes to one place only — so the flip orphaned every
 * pin that predated it. `resolvePinAcrossSources` is what actually delivers the
 * portability, and it carries the production account.
 *
 * ## What a missing image looks like
 *
 * `fromRegistry` is lazy — it hands back a handle without pulling — so an image
 * that was never published surfaces as a failure at sandbox CREATE, not here.
 * That is why the chosen source and its registry are logged at boot: "which
 * image am I pulling, and from where" has to be answerable from one line rather
 * than inferred from the shape of a later pull error. Same argument as
 * `describeSandboxBackend`'s reason string.
 *
 * The boot line is not sufficient on its own, because what Modal reports for a
 * missing manifest is `Image build for im-<id> failed with the exception:` and
 * then NOTHING — it sends no exception text for a `skopeo` pull failure, so the
 * one string a reader gets names no tag, no reference and no remedy. Every pull
 * reference is therefore logged where it is still known
 * (`resolvePinAcrossSources`); the boot line says which source, that line says
 * which image.
 */

import type { App, Image, ModalClient } from "modal";
import { createLogger } from "./logger.ts";
import { createHarnessImageResolver, localHarnessImageTag } from "./modal-harness-image.ts";

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
    fromName(tag: string): Promise<TImage>;
    fromRegistry(tag: string): TImage;
  };
};

/** Env var naming the registry guest images are pulled from. */
export const GUEST_IMAGE_REGISTRY_ENV = "GUEST_IMAGE_REGISTRY";

/**
 * The registry to pull guest images from, or `undefined` for the snapshot path.
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
  kind: "registry" | "snapshot";
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
   * Build the current image ahead of any spawn, where that means anything.
   *
   * It means something only for the snapshot source, whose first spawn would
   * otherwise pay a multi-minute image build. A registry pull has nothing to
   * prewarm — `fromRegistry` is lazy and Modal pulls at create time — so this
   * is a declared no-op there rather than an accident of the shape.
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
 * and every studio broker call. The snapshot resolver memoizes it for the same
 * reason; this is that cache for the registry path.
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
 * Resolve a PINNED tag from whichever source actually holds its bytes.
 *
 * The module doc above used to conclude, from the tag being source-independent,
 * that "a pin recorded under one source resolves under the other". The tag is;
 * the IMAGE is not. A tag names a `(base image, harness code, toolchain)` triple
 * — it says nothing about where the bytes for that triple were published, and
 * each source publishes to one place only: the snapshot source to Modal
 * (`image.publish(tag)`), this one's CI to the registry. So flipping the source
 * orphaned every pin an earlier deploy had recorded, and `agents.harness_image_tag`
 * is exactly the column that outlives a flip.
 *
 * It is not hypothetical. On the day after `GUEST_IMAGE_REGISTRY` was first set
 * in production, five distinct pinned tags — every agent deployed before the
 * flip — resolved to `ghcr.io/<owner>/aai-guest-harness:<sha16>`, which the
 * registry has never held. All five were live Modal images. Verified from
 * outside the process: `images.fromName` answered for all five and GHCR's
 * `/v2/.../tags/list` held none of them.
 *
 * ## What the failure looked like, and why it had to be fixed HERE
 *
 * `fromRegistry` is LAZY — it hands back a handle without pulling — so nothing
 * on the resolution path can fail, and `resolveSpawnImage`'s authored
 * "pinned harness image <tag> is unresolvable — redeploy the agent, or set
 * SANDBOX_IGNORE_IMAGE_PINS=1" is structurally unreachable on this source. The
 * failure re-emerged two layers down at sandbox CREATE, as Modal's
 * `Image build for im-<id> failed with the exception:` — with an EMPTY
 * exception, because Modal sends none for a `skopeo` manifest miss. So the
 * operator got 66 x `503 agent unavailable, retry shortly` and one log line
 * that named neither the tag, the registry, nor the kill switch.
 *
 * ## Modal first, and the cost
 *
 * Ordered the way it is because only one order can be EAGER. A Modal miss is a
 * definitive `NotFoundError` on one gRPC call; a registry miss is unobservable
 * until the pull. So Modal answers the question "was this pin minted before the
 * flip?" — nothing publishes there any more, so a tag Modal holds is a
 * pre-flip pin by construction, and its snapshot is literally the image that
 * agent was deployed against.
 *
 * Memoized per tag, so the extra round trip is once per distinct pin per
 * process rather than once per spawn — and only on the PINNED path, which is
 * already the slow one.
 *
 * **This has an end condition**: when no `agents` row holds a pre-flip pin, every
 * lookup here is a wasted miss and this function should go with the snapshot
 * source it exists to bridge (see the module doc on deleting that half).
 */
function resolvePinAcrossSources<TImage>(deps: {
  client: GuestImageClient<TImage>;
  registry: string;
}): (tag: string) => Promise<TImage> {
  const { client, registry } = deps;
  const memo = new Map<string, Promise<TImage>>();
  const resolve = async (tag: string): Promise<TImage> => {
    try {
      const image = await client.images.fromName(tag);
      log.info("pinned guest image resolved from Modal, not the registry", { tag });
      return image;
    } catch {
      // Not a pre-flip pin. Logged at INFO rather than swallowed because it is
      // the only place the pull REFERENCE is knowable: a `manifest unknown`
      // arrives later with no tag attached, and correlating the two by hand is
      // what this line exists to save.
      const ref = guestImageRef(registry, tag);
      log.info("pulling pinned guest image from the registry", { tag, ref });
      return client.images.fromRegistry(ref);
    }
  };
  return (tag) => {
    let pending = memo.get(tag);
    if (pending === undefined) {
      // A REJECTED lookup must not be cached: the registry gaining the tag (a
      // late `Guest image` workflow run) has to be visible without a restart.
      pending = resolve(tag).catch((err: unknown) => {
        memo.delete(tag);
        throw err;
      });
      memo.set(tag, pending);
    }
    return pending;
  };
}

/**
 * The registry source. Narrow by construction — it needs a registry, a base tag
 * and the two image lookups, and nothing else, which is what makes it testable
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
   * Tags whose reference has already been logged.
   *
   * The reference is logged for the CURRENT image too, not only for a pin. The
   * module doc's promise — "every pull reference is therefore logged where it is
   * still known" — was kept by `resolvePinAcrossSources` alone, so it held only
   * on the PINNED path. A studio session carries no pin and neither does a
   * first-ever agent spawn, so the commonest miss of all was the one that logged
   * nothing: `manifest unknown` arrives from Modal with no tag attached, as an
   * `Image build for im-<id> failed with the exception:` and then an EMPTY
   * exception, and the operator got that one line naming neither the tag, the
   * registry, nor `SANDBOX_IGNORE_IMAGE_PINS`. The reference had to be read out
   * of Modal's own build log instead.
   *
   * Once per distinct tag rather than once per spawn: the tag changes only with
   * the harness build, so this is a line per harness version per process, and a
   * per-spawn line on the hot cold-start path would be noise that buries itself.
   */
  const logged = new Set<string>();
  // `fromRegistry` is synchronous and lazy; a public registry needs no Secret,
  // which is why none is threaded through. Do not add the parameter until a
  // private registry actually uses it.
  const pull = (tag: string): Promise<TImage> => {
    const ref = guestImageRef(registry, tag);
    if (!logged.has(tag)) {
      logged.add(tag);
      log.info("pulling the current guest image from the registry", { tag, ref });
    }
    return Promise.resolve(client.images.fromRegistry(ref));
  };
  return {
    kind: "registry",
    reason: `${GUEST_IMAGE_REGISTRY_ENV}=${registry}`,
    // The CURRENT harness image is only ever the registry's: on this source
    // nothing publishes to Modal, so a Modal lookup for it is a guaranteed miss
    // and a wasted round trip on every cold spawn. The migration affordance
    // below is scoped to PINS, which are the only tags that can predate the flip.
    current: (code) => pull(tagOf(code)),
    byTag: resolvePinAcrossSources({ client, registry }),
    prepare: async () => {
      // Declared no-op — see GuestImageSource.prepare.
    },
  };
}

/** The legacy source: build the image here and publish it to Modal. */
export function snapshotImageSource(deps: {
  client: ModalClient;
  app: App;
  baseTag: string;
  baseImage: Image;
}): GuestImageSource {
  const harnessImage = createHarnessImageResolver(deps);
  return {
    kind: "snapshot",
    reason: `${GUEST_IMAGE_REGISTRY_ENV} unset — building the Modal snapshot image`,
    current: harnessImage,
    byTag: (tag) => deps.client.images.fromName(tag),
    prepare: async (code) => {
      await harnessImage(code);
    },
  };
}

/**
 * Resolve which image source this process uses. See the module doc for the
 * policy; the returned `reason` is what the boot log prints.
 *
 * `snapshot` arrives as a THUNK so the registry path constructs none of the
 * snapshot machinery — and so this selector needs only the narrow client,
 * which is what lets its own policy be tested without a Modal client at all.
 */
export function createGuestImageSource<TImage>(deps: {
  client: GuestImageClient<TImage>;
  baseTag: string;
  snapshot: () => GuestImageSource<TImage>;
  env?: NodeJS.ProcessEnv;
}): GuestImageSource<TImage> {
  const { client, baseTag, snapshot, env = process.env } = deps;
  const registry = guestImageRegistry(env);
  return registry === undefined ? snapshot() : registryImageSource({ client, baseTag, registry });
}
