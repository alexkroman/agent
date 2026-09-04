// Copyright 2026 the AAI authors. MIT license.
/**
 * Guarded access to the browser's key-value stores.
 *
 * Three modules in this package remember something across a load — the session
 * id (`session-resume-store.ts`), the upload ids a form has minted
 * (`_upload-recall.ts`) and a page's run correlation key (`use-run-key.ts`) —
 * and each had written out the same two rules by hand, eight `try`/`catch`
 * blocks and two URL-derived key builders between them. The tell was that each
 * module's doc cited the others as precedent, which is a convention held by
 * authors reading each other's comments rather than by code.
 *
 * Both rules are here once:
 *
 * - **Every access is guarded.** Storage THROWS outright in some contexts
 *   (Safari private mode, an iframe blocked by policy) and is ABSENT in others
 *   (any server-side render) — and reaching for the PROPERTY is itself what
 *   throws, before a method is called, which is why the guard has to wrap the
 *   lookup and not just the call. A caller that cannot remember must degrade to
 *   the behaviour it would have had anyway, never fail to render.
 * - **A slot is namespaced by the page's own URL**, so two agents served from
 *   one origin — every deployed agent, at `/:slug/` — cannot inherit each
 *   other's state.
 */

/** Which of the two stores; they differ only in how long an entry outlives the tab. */
export type StorageKind = "session" | "local";

/**
 * The store, or nothing.
 *
 * Not exported: a caller that reaches for the store itself has stepped outside
 * the guard, which is the whole point of this module.
 */
function storeFor(kind: StorageKind): Storage | undefined {
  return kind === "local" ? globalThis.localStorage : globalThis.sessionStorage;
}

/** The stored value, or undefined — for a missing entry and an absent store alike. */
export function storageGet(kind: StorageKind, key: string): string | undefined {
  try {
    return storeFor(kind)?.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Remember a value. A store that refuses is a no-op, never a throw. */
export function storageSet(kind: StorageKind, key: string, value: string): void {
  try {
    storeFor(kind)?.setItem(key, value);
  } catch {
    // Unavailable, or the quota is gone. Whatever this records also lives in
    // memory for the page's lifetime, so only the next load loses.
  }
}

/** Forget a value. Nothing stored and no store are the same outcome. */
export function storageRemove(kind: StorageKind, key: string): void {
  try {
    storeFor(kind)?.removeItem(key);
  } catch {
    // Nothing was stored, or storage is gone; either way there is nothing to do.
  }
}

/**
 * A storage key namespaced by a URL.
 *
 * `target` is resolved against the document, so a relative path ("./", the
 * default-client case) and the absolute form of the same agent agree on one
 * key.
 *
 * @param prefix - The owning module's namespace, e.g. `"aai:session:"`.
 * @param target - What to resolve — an agent's `platformUrl`, or `"./"` for the
 *   page's own directory.
 */
export function urlSlot(prefix: string, target: string): string {
  try {
    return `${prefix}${new URL(target, globalThis.location?.href).href}`;
  } catch {
    // Unresolvable: a document with an opaque origin, or a relative target with
    // no document at all. The raw string still separates two agents, which is
    // what the slot is for.
    return `${prefix}${target}`;
  }
}
