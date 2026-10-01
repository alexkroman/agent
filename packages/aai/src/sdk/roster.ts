// Copyright 2026 the AAI authors. MIT license.
/**
 * `roster()` — the agent's second voices, as ONE list: the {@link SpeakerDef}s
 * the model may hand the CALL to (`speaks: true`) and the ones it may hand a
 * TASK to. Two routing tools are minted from it — `handoff` over the speaking
 * entries, `delegate` over the rest — and both keep their own behaviour:
 *
 * - **`delegate`** runs the chosen speaker OFF the line (`ctx.delegate`): a
 *   second tool loop, its own context window, its conclusion handed back to
 *   whoever is speaking.
 * - **`handoff`** puts the chosen speaker ON the line: from the next model step
 *   its prompt section, its tools and its two per-request knobs are in force,
 *   over the SAME history and the SAME slots, until it hands on. That is
 *   LiveKit's handoff and OpenAI's `Agent.handoffs`, as a roster on the agent
 *   and a slot on the session.
 *
 * ```ts
 * import { agent, roster, speaker } from "@alexkroman1/aai";
 *
 * const triage = speaker({
 *   name: "triage",
 *   speaks: true,
 *   description: "Answers the phone, works out what the caller needs",
 *   systemPrompt: "Greet the caller and find out whether this is billing or a fault.",
 * });
 * const billing = speaker({
 *   name: "billing",
 *   speaks: true,
 *   description: "Invoices, payments and refunds",
 *   systemPrompt: "You are the billing desk. Verify the account before discussing charges.",
 * });
 *
 * export const desk = roster([triage, billing]);
 *
 * export default agent({ name: "Front Desk", roster: desk });
 * ```
 *
 * ## A speaker on the line is not a second agent, nor a dialog state
 *
 * The session — emitter, history, slots, transport, providers — stays one
 * object; a speaker is the part that can change mid-call without tearing any of
 * that down. The agent's own `systemPrompt` and `tools/` stay in force under
 * every speaker: one ADDS its section and its tools. The first speaking entry is
 * the ENTRY speaker and needs nothing special.
 *
 * A {@link Dialog} answers WHERE the conversation is; this answers WHO is
 * speaking. A dialog state may name a `persona` — a speaking entry — which PINS
 * it while the conversation is in that state ({@link DialogStateSpec.persona}),
 * and a handoff is otherwise a tool's decision: the minted `handoff` (the model
 * routes) or {@link Roster.handoff} from a tool body (the author routes). Both
 * write one session slot, so a resumed session comes back to whoever it left
 * on.
 *
 * ## The gate is at EXECUTION, and the tools stay advertised
 *
 * A speaking entry's tools are ADVERTISED on every transport (the tool list is
 * fixed per session, `sdk/toolset.ts`), so what makes billing's tool unreachable
 * while triage speaks is the roster toolset's GATE: the call is refused with a
 * `ToolRefusal` (`reason: "persona"`) naming who is speaking and how to hand
 * off. Hiding the tool per step would replace that sentence with a generic "no
 * such tool"; `aai-runtime/transports/pipeline/knobs/persona.ts` records it.
 *
 * @module roster
 */

import type { AnyDialog } from "./dialog-handle.ts";
import { omitUndefined } from "./omit-undefined.ts";
import { sessionSlot } from "./session-slot.ts";
import type { SlotHolder } from "./session-state.ts";
import type { SpeakerDef } from "./speaker.ts";

/** The name the model hands the CALL off by. @public */
export const HANDOFF_TOOL_NAME = "handoff";

/** The name the model hands a TASK off by. @public */
export const DELEGATE_TOOL_NAME = "delegate";

/** Per-call options for {@link Roster.handoff}. @public */
export interface HandoffOptions {
  /**
   * What the next speaker should know that the transcript does not say — "the
   * caller is verified", "wants a refund on invoice 4471". Rendered into the
   * new speaker's prompt section until the next handoff.
   */
  note?: string;
}

/**
 * Who is on the line — what {@link Roster.position} answers, the shape
 * `DialogPosition` has for a dialog.
 *
 * @sealed
 * @public
 */
export interface SpeakerPosition<N extends string = string> {
  /** The speaker on the line now. */
  readonly speaker: SpeakerDef<N>;
  /** Who handed off to it, when a handoff has happened this session. */
  readonly from?: string;
  /** The {@link HandoffOptions.note} that came with that handoff. */
  readonly note?: string;
  /**
   * The dialog PINNING this speaker, when a dialog state declares one. While a
   * pin is in force `handoff` to anyone else is refused.
   */
  readonly pinnedBy?: { readonly dialog: string; readonly state: string };
}

/**
 * What a handoff returns — the shape a tool hands back as its result so the
 * model learns, in the same turn, who is speaking now.
 *
 * @sealed
 * @public
 */
export interface HandoffResult {
  /** Always `true`: a discriminant a client or a spec can switch on. */
  readonly handoff: true;
  /** The speaker that was on the line. */
  readonly from: string;
  /** The speaker on the line now. */
  readonly to: string;
  /** The note that travelled with it, when one did. */
  readonly note?: string;
  /** What the MODEL should do next — its prompt section has already changed. */
  readonly instruction: string;
}

/**
 * The roster the agent declares and every tool reaches for — what
 * {@link roster} returns. A HANDLE, like {@link Dialog}: a handoff has to know
 * the whole roster to name who it came FROM and refuse a target not on it.
 *
 * @typeParam N - The roster's names, inferred from the literal names
 *   {@link speaker} gives each entry, so `desk.handoff(ctx, "biling")` is a
 *   compile error rather than a throw on a live call.
 *
 * @sealed
 * @public
 */
export interface Roster<N extends string = string> {
  /** Every entry, in declaration order. */
  readonly list: readonly SpeakerDef<N>[];
  /** The `speaks: true` entries, in order. The first is the ENTRY speaker. */
  readonly speaking: readonly SpeakerDef<N>[];
  /** The entries that run off the line — what `delegate` routes between. */
  readonly delegates: readonly SpeakerDef<N>[];
  /** Who is on the line, and how they came to be. Throws when nobody speaks. */
  position(ctx: SlotHolder): SpeakerPosition<N>;
  /** The speaker on the line now: `position(ctx).speaker`. */
  active(ctx: SlotHolder): SpeakerDef<N>;
  /**
   * Put `to` on the line from the next model step on — one slot write. Return
   * (or fold in) the {@link HandoffResult} as the calling tool's result.
   *
   * Throws when `to` is not a speaking entry, or a dialog state PINS another
   * one ({@link SpeakerPosition.pinnedBy}); the minted `handoff` tool turns
   * both into a `ToolRefusal` for the model.
   */
  handoff(ctx: SlotHolder, to: SpeakerDef<N> | N, options?: HandoffOptions): HandoffResult;
}

/**
 * The slot key — one per SESSION, because an agent declares one roster.
 *
 * @internal
 */
export const SPEAKER_SLOT_KEY = "aai.speaker";

/** What the slot stores: names, never defs — a def holds functions. */
interface HandoffRecord {
  /** The speaker on the line, or `null` for the entry speaker. */
  active: string | null;
  from: string | null;
  note: string | null;
}

const record = sessionSlot(
  SPEAKER_SLOT_KEY,
  (): HandoffRecord => ({ active: null, from: null, note: null }),
);

/**
 * The dialogs `agent()` bound to each roster, so {@link Roster.position} can
 * honour a state's `persona` pin. A `WeakMap` keyed by the handle: the handle
 * is built at MODULE scope, before `agent()` and its dialogs exist.
 */
const boundDialogs = new WeakMap<Roster, readonly AnyDialog[]>();

/** `agent()` calls this; see {@link boundDialogs}. @internal */
export function bindRosterDialogs(handle: Roster, dialogs: readonly AnyDialog[]): void {
  boundDialogs.set(handle, dialogs);
}

/**
 * Declare the roster — checked HERE, at module scope, because every refusal
 * below stands in for a failure with no symptom (two entries of one name route
 * to whichever the lookup finds; a tool two speakers own is gated by whichever
 * landed last).
 *
 * @public
 */
export function roster<const N extends string>(list: readonly SpeakerDef<N>[]): Roster<N> {
  assertRoster(list);
  const speaking = list.filter((one) => one.speaks === true);
  const byName = new Map<string, SpeakerDef<N>>(speaking.map((one) => [one.name, one]));

  const lookup = (name: string): SpeakerDef<N> => {
    const found = byName.get(name);
    if (found) return found;
    const known = list.some((one) => one.name === name);
    throw new Error(
      known
        ? `"${name}" is on this roster but does not speak, so it cannot take the call — delegate to it instead.`
        : `There is no speaker called "${name}" on this roster. Speaking: ${speaking.map((one) => one.name).join(", ") || "(none)"}.`,
    );
  };

  const pinned = (
    ctx: SlotHolder,
  ): { speaker: SpeakerDef<N>; dialog: string; state: string } | undefined => {
    for (const dialog of boundDialogs.get(handle) ?? []) {
      const at = dialog.position(ctx);
      if (at.persona !== undefined) {
        return { speaker: lookup(at.persona), dialog: dialog.key, state: at.state };
      }
    }
    return undefined;
  };

  const position = (ctx: SlotHolder): SpeakerPosition<N> => {
    const entry = speaking[0];
    if (entry === undefined) {
      throw new Error("This roster has no `speaks: true` entry, so nobody is on the line.");
    }
    const pin = pinned(ctx);
    if (pin) {
      return { speaker: pin.speaker, pinnedBy: { dialog: pin.dialog, state: pin.state } };
    }
    const stored = record.get(ctx);
    return {
      speaker: stored.active === null ? entry : lookup(stored.active),
      ...omitUndefined({ from: stored.from ?? undefined, note: stored.note ?? undefined }),
    };
  };

  const handle: Roster<N> = {
    list,
    speaking,
    delegates: list.filter((one) => one.speaks !== true),
    position,
    active: (ctx) => position(ctx).speaker,
    handoff(ctx, to, options = {}) {
      const target = lookup(typeof to === "string" ? to : to.name);
      const at = position(ctx);
      if (at.pinnedBy && at.speaker.name !== target.name) {
        throw new Error(
          `Cannot hand off to "${target.name}": the "${at.pinnedBy.dialog}" dialog is in its "${at.pinnedBy.state}" state, which pins "${at.speaker.name}". Move the dialog first.`,
        );
      }
      const from = at.speaker.name;
      const already = from === target.name;
      // Handing off to whoever is already speaking WRITES NOTHING: a write would
      // record a handoff to itself, and under a pin outlive the pin.
      if (!already) record.set(ctx, { active: target.name, from, note: options.note ?? null });
      return {
        handoff: true,
        from,
        to: target.name,
        ...omitUndefined({ note: options.note }),
        instruction: already
          ? `You are already ${target.name}. Carry on.`
          : `You are now ${target.name}. From here on, speak and act as ${target.name}: follow that speaker's instructions in your system prompt, and use its tools. Continue the conversation without restarting it.`,
      };
    },
  };
  return handle;
}

/** Refuse a roster that cannot route — each refusal is a failure with NO SYMPTOM otherwise. */
function assertRoster(list: readonly SpeakerDef[]): void {
  if (list.length === 0) {
    throw new Error(
      "roster([]) declares nobody — `handoff` and `delegate` would offer the model no one to " +
        "choose. List the speakers, or drop the roster.",
    );
  }
  const names = new Set<string>();
  const owners = new Map<string, string>();
  for (const one of list) {
    assertSpeaker(one);
    if (names.has(one.name)) {
      throw new Error(
        `Two speakers on this roster are called "${one.name}". The name is what the model routes ` +
          "by, so one of them has to be renamed.",
      );
    }
    names.add(one.name);
    if (one.speaks !== true) continue;
    for (const toolName of Object.keys(one.tools ?? {})) assertToolOwner(toolName, one, owners);
  }
}

/** The fields a roster entry cannot route without, each refused by name. */
function assertSpeaker(one: SpeakerDef): void {
  if (one.name.trim() === "") throw new Error("A speaker needs a name.");
  if ((one.description ?? "").trim() === "") {
    throw new Error(
      `The speaker "${one.name}" is on a roster and has no \`description\`. That is the only thing ` +
        'the model reads when it picks one — add a line saying what this one is FOR (e.g. "Invoices, payments and refunds").',
    );
  }
  if (one.systemPrompt.trim() === "") {
    throw new Error(
      `The speaker "${one.name}" has no \`systemPrompt\`. One with no instructions of its own ` +
        "behaves exactly as the agent does, and routing to it changes nothing.",
    );
  }
}

/** One speaking tool, one owner — and never a name the roster mints. */
function assertToolOwner(toolName: string, one: SpeakerDef, owners: Map<string, string>): void {
  if (toolName === HANDOFF_TOOL_NAME || toolName === DELEGATE_TOOL_NAME) {
    throw new Error(
      `The speaker "${one.name}" declares a tool called "${toolName}", which is the name of a ` +
        "tool the roster mints. Rename it.",
    );
  }
  const owner = owners.get(toolName);
  if (owner !== undefined) {
    throw new Error(
      `The tool "${toolName}" is declared by two speakers, "${owner}" and "${one.name}". A tool has ` +
        "one owner — the gate has to know whose it is — so put it on the agent's tools/ if both need it.",
    );
  }
  owners.set(toolName, one.name);
}
