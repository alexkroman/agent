// Copyright 2026 the AAI authors. MIT license.
/**
 * `createLinkedClient` — which client this page IS: a device it was linked to
 * (by a spoken code, a QR scan, a pairing flow of the app's own), else this
 * browser's own `browserClientId()`.
 *
 * A page linked to a speaker becomes the speaker's twin: it sends the
 * speaker's id as `?client=`, so its sessions join the speaker's durable
 * conversation and its inbox takes the speaker's reminders. Every such page
 * kept the link in `localStorage` and wrote the same read-validate-fallback;
 * the part worth having once is the VALIDATION — a stored id that is not a
 * client id (letters, digits, `-`, `_`, at most 64) is treated as no link, so
 * a corrupted entry falls back to the browser's own id rather than being sent
 * and ignored by the server (a session with no client at all).
 *
 * @module
 */

import { CLIENT_ID_RE } from "@alexkroman1/aai/internal";
import { storageGet, storageRemove, storageSet } from "./_web-storage.ts";
import { browserClientId } from "./client-identity.ts";

/**
 * Options for {@link createLinkedClient}.
 *
 * @public
 */
export type LinkedClientOptions = {
  /** The `localStorage` key the link is kept under, used as given — choose one that is yours. */
  key: string;
  /**
   * This browser's own id, used while unlinked. Default: {@link browserClientId}
   * for the page's agent — pass your own to carry over an id minted before.
   */
  fallback?: (() => string) | undefined;
};

/**
 * Which client a page is — see {@link createLinkedClient}.
 *
 * @public
 */
export type LinkedClient = {
  /** The client this page is now: the linked one, else this browser's own. */
  id(): string;
  /** The linked client, or `undefined` while unlinked. */
  linked(): string | undefined;
  /** This browser's own id, linked or not — what it asks for a link code AS. */
  own(): string;
  /**
   * Link to `id` (`undefined` unlinks). An invalid id unlinks too. Takes effect
   * on the next read — a mounted session's next connection attempt, since
   * `mountClient({ client })` asks per attempt; reload to move the inbox too.
   */
  set(id: string | undefined): void;
  /** Unlink: back to this browser's own id. */
  clear(): void;
};

/**
 * A page's client id with a link on top — see this module's doc.
 *
 * @example A page that can be linked to a speaker
 * ```ts
 * import { createLinkedClient, mountClient } from "@alexkroman1/aai-ui";
 *
 * const client = createLinkedClient({ key: "my-speaker:linked" });
 *
 * mountClient({ client: client.id });
 * // …after the speaker reads out its id: client.set(spokenId); location.reload();
 * ```
 *
 * @param options - Where the link is kept, and the unlinked id; see {@link LinkedClientOptions}.
 * @returns The handle; see {@link LinkedClient}.
 *
 * @public
 */
export function createLinkedClient(options: LinkedClientOptions): LinkedClient {
  const { key } = options;
  const own = options.fallback ?? (() => browserClientId());
  const linked = (): string | undefined => {
    const id = storageGet("local", key);
    return id && CLIENT_ID_RE.test(id) ? id : undefined;
  };
  const clear = (): void => storageRemove("local", key);
  return Object.freeze({
    id: () => linked() ?? own(),
    linked,
    own,
    set(id: string | undefined) {
      if (id && CLIENT_ID_RE.test(id)) storageSet("local", key, id);
      else clear();
    },
    clear,
  });
}
