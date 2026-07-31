// Copyright 2026 the AAI authors. MIT license.
/**
 * Harness-baked snapshot images (see modal-sandbox.ts for the spawn flow).
 *
 * Built at most once per (base image, harness code) pair: a throwaway
 * builder sandbox writes the harness, its filesystem is snapshotted, and
 * the resulting Image is published under a content-addressed tag so every
 * later spawn (and every other replica, across restarts) resolves it with
 * one `images.fromName` call. A new harness build or a base-image change
 * mints a new tag.
 *
 * This is the only harness-delivery path — a failed build fails the spawn
 * loudly; the memo is cleared so the next spawn retries (a transient
 * control-plane error must not disable sandboxing for the process lifetime).
 */

import { createHash } from "node:crypto";
import type { App, Image, ModalClient } from "modal";
import { debug } from "./_debug-log.ts";

/** Where the guest harness lives inside the baked image. */
export const HARNESS_REMOTE_PATH = "/opt/aai/harness.mjs";

/** Name the harness-baked snapshot images are published under. */
const HARNESS_IMAGE_NAME = "aai-guest-harness";

/** Budget for the one-time harness-image build (spawn + write + snapshot). */
const HARNESS_IMAGE_BUILD_TIMEOUT_MS = 10 * 60_000;

export type HarnessImageResolver = (code: string) => Promise<Image>;

/** Build the memoizing (code → published snapshot Image) resolver. */
export function createHarnessImageResolver(deps: {
  client: ModalClient;
  app: App;
  baseTag: string;
  baseImage: Image;
}): HarnessImageResolver {
  const { client, app, baseTag, baseImage } = deps;
  const memo = new Map<string, Promise<Image>>();

  function tagFor(code: string): string {
    const hash = createHash("sha256").update(baseTag).update("\0").update(code).digest("hex");
    return `${HARNESS_IMAGE_NAME}:${hash.slice(0, 16)}`;
  }

  async function build(tag: string, code: string): Promise<Image> {
    try {
      // Another replica (or a previous run of this one) may have published it.
      return await client.images.fromName(tag);
    } catch {
      // Not published yet — build it below.
    }
    const builder = await client.sandboxes.create(app, baseImage, {
      command: ["sleep", "infinity"],
      blockNetwork: true,
      timeoutMs: HARNESS_IMAGE_BUILD_TIMEOUT_MS,
      tags: { service: "aai-guest-image-build" },
    });
    try {
      await builder.filesystem.writeText(code, HARNESS_REMOTE_PATH);
      const image = await builder.snapshotFilesystem();
      await image.publish(tag);
      debug("Harness snapshot image published", { tag });
      return image;
    } finally {
      await builder.terminate().catch(() => undefined);
    }
  }

  return (code: string): Promise<Image> => {
    const tag = tagFor(code);
    let pending = memo.get(tag);
    if (!pending) {
      pending = build(tag, code).catch((err: unknown) => {
        memo.delete(tag);
        throw err;
      });
      memo.set(tag, pending);
    }
    return pending;
  };
}
