// Copyright 2026 the AAI authors. MIT license.
/**
 * The handle a page keeps on the runs it started, across a reload.
 *
 * `useWorkflowSubmit({ key, recover: true })` is what makes a run survivable —
 * the run id is that hook's own state, so a refresh loses it while the run
 * carries on — and the `key` is deliberately the caller's to choose, because it
 * is a lookup CAPABILITY: there is no per-user filtering behind `find`, so the
 * key IS the scoping mechanism. Choosing one is easy to get wrong in three
 * separate ways, and six shipped templates had each written the same twenty
 * lines to get it right. This is those lines.
 *
 * ## Three properties, and the rejected alternatives are why each one matters
 *
 * - **Opaque** — `crypto.randomUUID()`, never derived from what was submitted.
 *   A key derived from the input collides the moment two people submit the same
 *   thing, and they then recover each other's runs; it also carries what they
 *   typed into a lookup token the platform deliberately stopped logging.
 * - **Short.** A `randomUUID` is 36 characters, well inside the 256 that
 *   `POST /workflows/runs` allows a key.
 * - **Minted once per load and written back for the next one**, which is the
 *   whole mechanism: the load that presses the button records the key with the
 *   run, and the load after it finds the run by producing the same key.
 *
 * Storage rather than the page's own URL, for all of them. A `?key=` parameter
 * survives more (a new tab, a bookmark, a shared link) and that is the problem:
 * a URL is pasted into chats, copied into referrers and kept in history, and
 * what a leaked one buys is somebody else's work — reading it, and `cancel()` on
 * it. An app with accounts should pass the ACCOUNT's own id here instead, and
 * then a run follows the person to a new device, which is a promise only a login
 * can keep.
 *
 * ## The storage is the caller's decision, and it is not a detail
 *
 * `"session"` (the default) dies with the tab, which covers exactly the
 * interruption most pages have — a reload, a same-tab navigation, a crashed tab
 * — and is the same lifetime as this package's other two stores, the session
 * resume id (`session-resume-store.ts`) and the upload recall
 * (`_upload-recall.ts`), so both halves of a reload make the same promise.
 *
 * `"local"` is for a run that outlives all of that BY DESIGN — one that sleeps
 * between digests and may live a month, where closing the browser on Tuesday and
 * coming back on Friday to press Stop is the ordinary case rather than an edge
 * one, and a tab-scoped key would answer that with an empty form beside a run
 * still posting somewhere. It is as far as a key can go without a login, and no
 * further. `podcast-digest` is that template; the other five ship the default.
 *
 * ## Anything ELSE a page stores back must be VALIDATED on read
 *
 * This key needs no validation, and it is worth saying why, because it is the
 * exception: any string is a legal key, so a value from storage can only fail to
 * match a run. A page that remembers something more — which MODE submitted, say
 * — is remembering a value it will turn into a name, and storage hands back a
 * string some earlier version of that page wrote: a renamed mode, a hand-edited
 * value, a slot another app on the origin happens to share. Unchecked, that
 * starts a run called `undefined` and answers a 400 nobody typed. Check it
 * against the page's own list on the way out (`recalledMode` in
 * `transcription-workflow/recover.ts` is the worked example) — the recall is the
 * page's, the validation is not optional.
 *
 * ## The slot is keyed by the page's own URL
 *
 * Every deployed agent is served from one origin at `/:slug/`, so a fixed name
 * would have two agents scaffolded from the same template recover each other's
 * runs. The key is the page's own directory — resolved through `"./"`, which
 * drops the query and the hash, since a reload carrying `?foo` or `#bar` has to
 * find the same key. Same call `session-resume-store.ts` makes, for the same
 * reason.
 *
 * One key per PAGE is right even for a page driving several workflows: `find` is
 * scoped by workflow as well as by key, so three hooks sharing one key recover
 * three separate runs. `transcription-workflow` is that page.
 *
 * Every access is guarded. Storage THROWS outright in some contexts (Safari
 * private mode, an iframe blocked by policy) and is ABSENT in others (any
 * server-side render), and a page that cannot remember its key must degrade to
 * the behaviour it would have had anyway — one run per load — rather than
 * failing to render.
 */

import { useState } from "react";

/** Where a run key lives, namespaced like this package's two other stores. */
const PREFIX = "aai:run-key:";

/** This page's own slot — see "The slot is keyed by the page's own URL". */
function slotFor(): string {
  const href = globalThis.location?.href;
  if (href === undefined) return PREFIX;
  try {
    return `${PREFIX}${new URL("./", href).href}`;
  } catch {
    // Unresolvable (a document with an opaque origin). The raw href still
    // separates two agents, which is what the slot is for.
    return `${PREFIX}${href}`;
  }
}

/**
 * Read the key this page already has, or mint and remember one.
 *
 * Not exported: a page that wants a key wants it for the life of a component,
 * which is what the hook is. Calling this per render would mint a fresh key and
 * hand `recover` one nothing was ever started under.
 */
function mintRunKey(storage: "session" | "local"): string {
  try {
    // Read INSIDE the guard: reaching for the property is itself what throws in
    // a blocked iframe, before any method is called.
    const store = storage === "local" ? globalThis.localStorage : globalThis.sessionStorage;
    const slot = slotFor();
    const stored = store?.getItem(slot);
    if (stored !== null && stored !== undefined) return stored;
    const minted = crypto.randomUUID();
    store?.setItem(slot, minted);
    return minted;
  } catch {
    return crypto.randomUUID();
  }
}

/**
 * A lookup key for `useWorkflowSubmit({ key, recover: true })`, stable across
 * reloads.
 *
 * @param options - See the module doc for the whole argument. The storage kind
 *   is read once, when the key is minted: a value that changed afterwards would
 *   be asking to move a key that has already been recorded with a run.
 * @returns The key to record runs under and to look them up by — the same one
 *   for the life of the component, and for the next load in the same tab (or the
 *   same browser, under `"local"`).
 */
export function useRunKey(
  options: {
    /**
     * Which store keeps the key between loads.
     *
     * `"session"` (the default) dies with the tab; `"local"` survives the
     * browser closing, which is what a run that sleeps for days needs. See "The
     * storage is the caller's decision".
     */
    storage?: "session" | "local";
  } = {},
): string {
  const { storage = "session" } = options;
  // `useState`'s lazy initializer rather than a call in the render body, which
  // would mint a fresh key on every re-render.
  const [key] = useState(() => mintRunKey(storage));
  return key;
}
