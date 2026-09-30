// Copyright 2026 the AAI authors. MIT license.
/**
 * A string a page remembers in this browser — a setting, a phone number, a
 * linked device — readable outside React (a `mountClient({ phone })` getter
 * asked on every connect) and reactive inside it.
 *
 * Built on `_web-storage.ts`, so it inherits that module's rule: every access
 * is guarded, and a browser that refuses storage (private mode, a blocked
 * iframe) degrades to a value held in memory for the tab — the page still
 * works, it just forgets on reload. On top of that:
 *
 * - **Every holder of a key sees a write** — two components, a component and a
 *   getter, and other TABS (the `storage` event), so a setting changed in one
 *   place is not stale in another.
 * - **An empty value is no value**: writing `""` REMOVES the entry, so the next
 *   read is the `initial` again rather than a stored blank.
 *
 * @module
 */

import { useMemo, useSyncExternalStore } from "react";
import { type StorageKind, storageGet, storageRemove, storageSet } from "./_web-storage.ts";

/**
 * Options for {@link createStoredValue}.
 *
 * @public
 */
export type StoredValueOptions = {
  /** What a read answers while nothing is stored. Default `""`. */
  initial?: string | undefined;
  /** `"local"` (the default) outlives the tab; `"session"` does not. */
  storage?: "local" | "session" | undefined;
};

/**
 * One remembered string — see {@link createStoredValue}.
 *
 * @public
 */
export type StoredValue = {
  /** The storage key, as given. */
  readonly key: string;
  /** The value now: what is stored, else the `initial`. */
  get(): string;
  /** Remember `value`; `""` or `undefined` forgets it. Every holder of the key is told. */
  set(value: string | undefined): void;
  /** Be told when the value changes — here, in another holder, or in another tab. */
  subscribe(listener: () => void): () => void;
};

/** Listeners per `kind:key`, shared by every holder in this realm. */
const listeners = new Map<string, Set<() => void>>();
/** Values for a storage that refused them, per `kind:key` — the in-memory fallback. */
const memory = new Map<string, string | undefined>();
let watchingOtherTabs = false;

function notify(slot: string): void {
  for (const listener of listeners.get(slot) ?? []) listener();
}

/** Another tab wrote the key: tell this tab's holders. Only `localStorage` is shared. */
function watchOtherTabs(): void {
  if (watchingOtherTabs || typeof window === "undefined") return;
  watchingOtherTabs = true;
  window.addEventListener("storage", (event) => {
    if (event.key === null) {
      for (const slot of listeners.keys()) notify(slot);
    } else {
      notify(`local:${event.key}`);
    }
  });
}

/**
 * A string remembered in this browser under `key` — see this module's doc.
 *
 * Create it once at module scope and share it: `get()` in a getter outside
 * React, {@link useStoredValue} in a component.
 *
 * The key is used as given, so choose one that is yours (`"my-app:phone"`);
 * two agents on one origin share a key they both name.
 *
 * @example A phone number for the session, edited in a settings field
 * ```tsx
 * import { createStoredValue, mountClient, phoneE164, useStoredValue } from "@alexkroman1/aai-ui";
 *
 * const phone = createStoredValue("my-speaker:phone");
 *
 * function PhoneField() {
 *   const [value, setValue] = useStoredValue(phone);
 *   return <input defaultValue={value} onBlur={(e) => setValue(e.currentTarget.value.trim())} />;
 * }
 *
 * mountClient({ phone: () => phoneE164(phone.get()), component: PhoneField });
 * ```
 *
 * @param key - The storage key.
 * @param options - `initial` and which storage; see {@link StoredValueOptions}.
 * @returns The value's handle; see {@link StoredValue}.
 *
 * @public
 */
export function createStoredValue(key: string, options: StoredValueOptions = {}): StoredValue {
  const kind: StorageKind = options.storage ?? "local";
  const initial = options.initial ?? "";
  const slot = `${kind}:${key}`;
  return {
    key,
    get() {
      const stored = storageGet(kind, key);
      if (stored !== undefined) return stored;
      return memory.get(slot) ?? initial;
    },
    set(value) {
      const next = value === "" ? undefined : value;
      if (next === undefined) storageRemove(kind, key);
      else storageSet(kind, key, next);
      // Remembered in memory only when storage did not take it.
      memory.set(slot, storageGet(kind, key) === next ? undefined : next);
      notify(slot);
    },
    subscribe(listener) {
      watchOtherTabs();
      const set = listeners.get(slot) ?? new Set();
      set.add(listener);
      listeners.set(slot, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(slot);
      };
    },
  };
}

/**
 * A remembered string as React state: the value, and a setter that writes it
 * through to storage — see this module's doc.
 *
 * Pass the key (and an `initial`) for a value one component owns, or a
 * {@link StoredValue} shared with code outside React.
 *
 * @example
 * ```tsx
 * import { useStoredValue } from "@alexkroman1/aai-ui";
 *
 * function Units() {
 *   const [units, setUnits] = useStoredValue("my-app:units", "metric");
 *   return (
 *     <button type="button" onClick={() => setUnits(units === "metric" ? "imperial" : "metric")}>
 *       {units}
 *     </button>
 *   );
 * }
 * ```
 *
 * @param source - A storage key, or a {@link StoredValue}.
 * @param initial - With a key: what to answer while nothing is stored. Default `""`.
 *   Ignored with a `StoredValue`, which carries its own.
 * @returns `[value, setValue]`; `setValue("")` forgets it.
 *
 * @public
 */
export function useStoredValue(
  source: StoredValue | string,
  initial?: string,
): [string, (value: string | undefined) => void] {
  const stored = useMemo(
    () => (typeof source === "string" ? createStoredValue(source, { initial }) : source),
    [source, initial],
  );
  const value = useSyncExternalStore(stored.subscribe, stored.get, stored.get);
  return [value, stored.set];
}
