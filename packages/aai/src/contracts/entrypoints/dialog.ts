// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `dialog`.
 *
 * The dialog statechart: what an agent may do NEXT, declared rather than asked
 * for in prose. A gated tool refuses at EXECUTION when the conversation is
 * somewhere else, and every dialog tool's result carries the position it landed
 * in — see `sdk/dialog.ts` for why the enforcement point is execution and not the
 * advertised tool list.
 *
 * Its own capability rather than part of `state` even though it is BACKED by a
 * session slot: a slot is where a value lives and this is what may happen next,
 * so an author reaches for them for different reasons and a signature change in
 * one says nothing about the other.
 *
 * `DialogSpec`, `DialogStateSpec` and `DialogEvent` are the DECLARED form, and
 * they are part of this contract for the same reason the machine overload is:
 * they are what an author writes. A spec is `{ initial, states }` where a state
 * carries `instruction`, `on`, `final`, `initial` and nested `states` — the six
 * XState features every dialog here used, and not a subset chosen for
 * convenience, since a dialog's snapshot is PERSISTED and must survive
 * `structuredClone`, which rules out guards, context, actions and invoked actors
 * by construction. `DialogEvent<S>` is the union the `on` maps already spell, so
 * the event names a `send` accepts are derived from the states rather than
 * restated beside them. The machine overload stays on the contract too:
 * `procedure()` needs full XState and the escape hatch is part of the promise.
 *
 * **Six names joined this contract when a dialog learned to represent a CALL**,
 * and they are on it for the reason the declared form already was — they are
 * what an author writes. `DialogTimeoutSpec` is a state's own deadline, which
 * `after` could not be: the actor `dialog()` builds lives for one synchronous
 * window, so a delayed transition never fires and the reachability walk used to
 * green-light one anyway. `DialogSessionEventName` is the `@`-prefixed half of
 * an `on` map — the wire's own event names, so a rename there breaks every
 * dialog written against it, which is exactly what an epoch is for.
 * `DialogVoiceConfig` and `DialogBargeIn` are the per-state knobs, and only
 * three of the five take effect today. `DialogTimeout` and `AnyDialog` are what
 * the RUNTIME reads — the second is `AgentDef.dialogs`' element type, so it is
 * named by `agent`'s contract as well and declared here, where the concept
 * lives, rather than in both.
 *
 * Re-exported from `@alexkroman1/aai`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  type AnyDialog,
  type Dialog,
  type DialogBargeIn,
  type DialogEvent,
  type DialogOptions,
  type DialogPosition,
  type DialogSessionEventName,
  type DialogSpec,
  type DialogStateSpec,
  type DialogTimeout,
  type DialogTimeoutSpec,
  type DialogToolDef,
  type DialogToolResult,
  type DialogVoiceConfig,
  dialog,
} from "../../index.ts";
