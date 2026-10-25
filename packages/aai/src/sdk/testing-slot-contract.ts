// Copyright 2026 the AAI authors. MIT license.
/**
 * The three invariants every `sessionSlot()` owes, asserted in one call.
 *
 * A slot is declared once and read from two ends — the server projects it,
 * the page renders the projection, every tool mutates it — and each of the
 * three things that can go quietly wrong with one is a claim a spec can make
 * about the DECLARATION rather than about any tool:
 *
 * 1. **The projection agrees with the default.** `slot.projected()` is the
 *    frame a page renders before the first tool call, and it must be the view
 *    of the default AS A SESSION STORES IT — `create()` with the slot's `after`
 *    hook and caps applied, which is what a fresh session installs. An `empty`
 *    seed that differs from the default, or a `create()` that hands back a
 *    SHARED object, drifts the two apart. A default already past one of its
 *    caps is reported under the cap it restates (invariant 3).
 * 2. **Sessions do not share state.** A write through one context is invisible
 *    through another; a slot whose default is a module-level object leaks the
 *    first session's writes into the second.
 * 3. **Each declared cap trims the OLDEST entries.** A cap is a promise about
 *    what survives, and the half a hand-rolled bound gets wrong is which END
 *    is kept.
 *
 * The caps are read off the handle (`slot.caps`, the declaration itself), so
 * every declared cap is checked without the spec restating one; a spec may
 * still pass `caps` to assert a PARTICULAR bound, and one that disagrees with
 * the declaration fails naming both numbers.
 *
 * Framework-agnostic: a throw with the invariant in its message, like every
 * reader on `@alexkroman1/aai/testing`.
 *
 * @module testing-slot-contract
 */

import { createToolContext } from "./_testing-context.ts";
import { isRecord } from "./is-record.ts";
import type { SessionSlot } from "./session-slot-handle.ts";

/**
 * What {@link expectSlotContract} may be told.
 *
 * @input
 * @public
 */
export type SlotContractOptions<T> = {
  /**
   * A mutation that CHANGES the value — what the isolation check writes
   * through one session to prove the other does not see it. Optional: without
   * it the check is that two sessions hold distinct values of the default,
   * which catches a shared default object and nothing subtler. A `write` that
   * leaves the value equal to the default is refused, because it proves
   * nothing.
   */
  readonly write?: ((draft: T) => void) | undefined;
  /**
   * The caps to check — each top-level array key and the most entries it
   * keeps. Defaults to what the slot DECLARED (`slot.caps`); given, each is
   * driven past its bound and the surviving entries must be the NEWEST ones,
   * and a bound that differs from the declared one fails naming both.
   */
  readonly caps?: Readonly<Record<string, number>> | undefined;
};

/**
 * Assert the three invariants of `slot`'s declaration — see the module doc.
 *
 * @throws Naming the invariant that failed, and for a cap the key.
 *
 * @example
 * ```ts
 * import { sessionSlot } from "@alexkroman1/aai";
 * import { expectSlotContract } from "@alexkroman1/aai/testing";
 *
 * const log = sessionSlot("log", () => ({ lines: [] as string[], total: 0 }), {
 *   caps: { lines: 50 },
 *   view: (value) => ({ count: value.lines.length }),
 * });
 *
 * expectSlotContract(log, {
 *   write: (draft) => {
 *     draft.lines.push("hello");
 *   },
 *   caps: { lines: 50 },
 * });
 * ```
 *
 * @public
 */
export function expectSlotContract<K extends string, T, V>(
  slot: SessionSlot<K, T, V>,
  options: SlotContractOptions<T> = {},
): void {
  assertProjectionAgrees(slot);
  assertSessionsIsolated(slot, options.write);
  const caps = options.caps ?? slot.caps ?? {};
  for (const [key, max] of Object.entries(caps)) {
    if (max !== undefined) assertCapTrimsOldest(slot, key, max);
  }
}

/** Invariant 1: the empty frame is the view of the default, and the default is fresh per call. */
function assertProjectionAgrees<K extends string, T, V>(slot: SessionSlot<K, T, V>): void {
  const { projected } = slot;
  if (projected.key !== slot.key) {
    throw new Error(
      `expectSlotContract("${slot.key}"): projected.key is ${JSON.stringify(projected.key)} — ` +
        "the projection must carry the slot's own key, or `syncState` frames it under another name",
    );
  }
  const first = slot.create();
  const second = slot.create();
  if (isRecord(first) && first === second) {
    throw new Error(
      `expectSlotContract("${slot.key}"): create() returned the SAME object twice — a shared ` +
        "default leaks one session's writes into the next. Return a fresh value per call.",
    );
  }
  const empty = projected();
  // The default as STORED — `after` and caps applied, through a fresh session
  // — rather than `create()` raw: `projected()` applies both to its own frame,
  // so a slot whose `after` derives a field would otherwise fail here on every
  // declaration that has one.
  const viewed = projected(storedDefault(slot));
  if (!sameJson(empty, viewed)) {
    throw new Error(
      `expectSlotContract("${slot.key}"): projected() is not the view of the default — the frame ` +
        `a page renders first differs from the stored default's projection. Rendered ` +
        `${describe(empty)}; the default projects to ${describe(viewed)}. An \`empty\` seed that ` +
        "differs from the default is the usual cause.",
    );
  }
}

/** The default as a fresh session stores it: `create()`, then `after`, then caps. */
function storedDefault<K extends string, T, V>(slot: SessionSlot<K, T, V>): T {
  return slot.snapshot(createToolContext());
}

/** Invariant 2: a write through one session is invisible through another. */
function assertSessionsIsolated<K extends string, T, V>(
  slot: SessionSlot<K, T, V>,
  write: ((draft: T) => void) | undefined,
): void {
  const a = createToolContext();
  const b = createToolContext();
  const before = slot.snapshot(a);
  const other = slot.get(b);
  if (isRecord(before) && (slot.get(a) as unknown) === other) {
    throw new Error(
      `expectSlotContract("${slot.key}"): two sessions hold the SAME value object — the slot's ` +
        "default is shared rather than created per session",
    );
  }
  if (write === undefined) return;
  slot.update(a, (draft) => {
    write(draft);
  });
  const after = slot.snapshot(a);
  if (sameJson(after, before)) {
    throw new Error(
      `expectSlotContract("${slot.key}"): the \`write\` left the value equal to the default, so ` +
        "it proves nothing about isolation. Mutate the draft so the stored value changes.",
    );
  }
  // Against the stored default (`before` is one), not `create()` raw — the
  // same reason `assertProjectionAgrees` gives.
  if (!sameJson(slot.snapshot(b), before)) {
    throw new Error(
      `expectSlotContract("${slot.key}"): a write through one session changed what another ` +
        `session reads — it now holds ${describe(slot.snapshot(b))} rather than the default`,
    );
  }
}

/** Invariant 3: driving `key` past `max` keeps the NEWEST `max` entries. */
function assertCapTrimsOldest<K extends string, T, V>(
  slot: SessionSlot<K, T, V>,
  key: string,
  max: number,
): void {
  const initial = slot.create();
  const declared = isRecord(initial) ? initial[key] : undefined;
  if (!Array.isArray(declared)) {
    throw new Error(
      `expectSlotContract("${slot.key}"): caps.${key} names no top-level array of the default — ` +
        `the default has ${isRecord(initial) ? `keys ${Object.keys(initial).join(", ") || "(none)"}` : describe(initial)}`,
    );
  }
  // A default past its own cap ships entries the first store drops — invisible
  // above, where the comparison is against the default as stored.
  if (declared.length > max) {
    throw new Error(
      `expectSlotContract("${slot.key}"): caps.${key} = ${max}, but the default already holds ` +
        `${declared.length} entries — the first store trims it, so the declared default is never ` +
        "what a session reads. Trim the default, or raise the cap.",
    );
  }
  const ctx = createToolContext();
  // Start from an EMPTY list, so the probes alone decide what survives, and
  // push one per update: a cap holds on every store, not only on a burst.
  slot.update(ctx, (draft) => {
    (draft as Record<string, unknown[]>)[key] = [];
  });
  const probes: string[] = [];
  for (let i = 0; i < max + 2; i += 1) {
    const probe = `${key}#${i + 1}`;
    probes.push(probe);
    slot.update(ctx, (draft) => {
      (draft as Record<string, unknown[]>)[key]?.push(probe);
    });
  }
  const kept = (slot.snapshot(ctx) as Record<string, unknown>)[key];
  const expected = probes.slice(-max);
  if (!sameJson(kept, expected)) {
    throw new Error(
      `expectSlotContract("${slot.key}"): caps.${key} = ${max} did not keep the newest ${max} ` +
        `of ${probes.length} entries — kept ${describe(kept)}, expected ${describe(expected)}. ` +
        whyCapFailed(slot.caps?.[key], key, max),
    );
  }
}

/**
 * Why a cap check failed, told from the DECLARATION: a restated bound the slot
 * never declared, one it declared differently, or the slot itself trimming
 * the wrong end.
 */
function whyCapFailed(declared: number | undefined, key: string, max: number): string {
  if (declared === max) return "The slot trims the wrong end.";
  if (declared === undefined) return `The slot declares no cap on ${key}.`;
  return `The slot declares caps.${key} = ${declared}, not ${max}.`;
}

/** Structural equality over the JSON-shaped values a slot holds. */
function sameJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => sameJson(item, b[i]));
  }
  if (isRecord(a) && isRecord(b) && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = Object.keys(a).filter((k) => a[k] !== undefined);
    const other = Object.keys(b).filter((k) => b[k] !== undefined);
    return keys.length === other.length && keys.every((k) => k in b && sameJson(a[k], b[k]));
  }
  return false;
}

/** A value quoted for a message, bounded so a large slot does not flood it. */
function describe(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
