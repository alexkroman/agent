// Copyright 2026 the AAI authors. MIT license.
/**
 * `personas()` — WHO is speaking, as a declared set the session can swap
 * between mid-call, and `handoff` as the move that swaps it.
 *
 * The SDK had two answers to "more than one agent" and neither changed who was
 * talking. `ctx.delegate` runs a second tool loop and hands its CONCLUSION back
 * to the same speaker; a `dialog()` says where the conversation IS and gates
 * tools on it, and its per-state `instruction` is a suffix on one prompt. What a
 * front desk needs is the third thing: triage answers the phone, verifies the
 * caller, and hands them to billing — after which billing's prompt, billing's
 * tools and billing's voice knobs are the ones in force, over the SAME history
 * and the SAME slots, for the rest of the call or until billing hands back. That
 * is LiveKit's handoff (a tool returns a new `Agent` and `chat_ctx` carries),
 * and OpenAI's `Agent.handoffs`; here it is a roster on the agent and a slot on
 * the session.
 *
 * ```ts
 * import { agent, persona, personas } from "@alexkroman1/aai";
 *
 * const triage = persona({
 *   name: "triage",
 *   description: "Answers the phone, works out what the caller needs",
 *   systemPrompt: "Greet the caller and find out whether this is billing or a fault.",
 * });
 * const billing = persona({
 *   name: "billing",
 *   description: "Invoices, payments and refunds",
 *   systemPrompt: "You are the billing desk. Verify the account before discussing charges.",
 * });
 *
 * export const desk = personas([triage, billing]);
 *
 * export default agent({ name: "Front Desk", personas: desk });
 * ```
 *
 * ## Persona, not a second agent
 *
 * A persona is NOT an `AgentDef`. The session — its emitter, its history, its
 * slots, its transport, its providers — is one object and stays one object; a
 * persona is the part of the agent that can change mid-call without tearing
 * any of that down: the instructions, the tool set, the two per-request model
 * knobs. Everything a persona does not declare is the agent's, and the agent's
 * own `systemPrompt` and `tools/` stay in force under every persona — a persona
 * ADDS its section and its tools, it does not replace the agent. That is also
 * why the first entry of the roster is the ENTRY persona and needs nothing
 * special: an agent with no personas is an agent whose entry persona has no
 * name.
 *
 * ## Persona, not a dialog state
 *
 * A {@link Dialog} answers WHERE the conversation is; this answers WHO is
 * speaking. They compose rather than compete: a dialog state may name a
 * `persona`, which PINS it for as long as the conversation is in that state
 * (see {@link DialogStateSpec.persona}), and a handoff is otherwise a tool's
 * decision. They are two things because a dialog state is a POSITION — nested,
 * concatenated across dialogs, moved mid-turn by a gated tool — and a persona
 * has to be exactly one at a time with one owner for its tool set. Folding one
 * into the other would have given two dialogs a way to disagree about who is
 * talking, with nothing to say which wins.
 *
 * ## Two ways to hand off, and both write the same slot
 *
 * The roster mints one `handoff` tool ({@link HANDOFF_TOOL_NAME}) whose
 * `persona` argument is an enum over the names and whose description is each
 * one's {@link PersonaDef.description} — the model routes. And a tool body may
 * call {@link Personas.handoff} itself — the author routes, when the tool IS
 * the decision (`verify_identity` succeeds, so billing takes over). Both write
 * one session slot, so a resumed session comes back to the persona it left on,
 * and the gate below reads it from wherever the tool runs.
 *
 * ## The gate is at EXECUTION, and the tools stay advertised
 *
 * A persona's tools are ADVERTISED to the model on every transport —
 * `toolSchemas` is computed once per session, the constraint `sdk/dialog.ts`
 * documents — so what makes a billing tool unreachable while triage is speaking
 * is the same move a dialog makes: the wrapped tool refuses at execution with a
 * result naming who is speaking and how to hand off. That refusal is the
 * recovery path the model needs, and it is deliberately not replaced by hiding
 * the tool per step: the AI SDK filters its EXECUTION set by `activeTools` too,
 * so a hidden tool the model still names is a generic "no such tool" error
 * rather than a sentence saying who to hand off to.
 * `aai-runtime/transports/pipeline-persona-knobs.ts` records the measurement.
 *
 * @module persona
 */

import type { AnyDialog } from "./dialog-handle.ts";
import { omitUndefined } from "./omit-undefined.ts";
import { sessionSlot } from "./session-slot.ts";
import type { SlotHolder } from "./session-state.ts";
import type { ToolChoice, ToolDef } from "./tool-def.ts";

/**
 * One persona: a speaker the session can hand the caller to.
 *
 * Every field but `tools`, `toolChoice` and `temperature` is required, and each
 * requirement is a failure with no symptom otherwise: a persona with no
 * `description` routes badly and reads as the model being unreliable; one with
 * no `systemPrompt` speaks as the agent and nobody can tell it took over.
 *
 * @public
 */
export interface PersonaDef {
  /**
   * What this persona is called — the value of the `handoff` tool's `persona`
   * argument, the name a log line carries, and what `position(ctx).name` is.
   */
  name: string;
  /**
   * What this persona is FOR, in one line, written for whoever is choosing
   * between personas: the `handoff` tool's description is these lines and
   * nothing else, so write it as the job ("Invoices, payments and refunds"),
   * not the mechanism.
   */
  description: string;
  /**
   * The instructions in force while this persona is speaking, appended to the
   * agent's own prompt under a heading naming the persona. The agent's
   * `systemPrompt` stays — this is the section that CHANGES on a handoff.
   */
  systemPrompt: string;
  /**
   * The tools only this persona may call, by the name the model calls them by.
   *
   * A MAP, like `subagent({ tools })`, because these are declared on the
   * persona rather than discovered from `tools/`: the agent's `tools/` files are
   * every persona's, and this is the strictly narrower set one persona owns.
   * Each name must be unique across the roster and must not collide with a
   * `tools/` file — one tool has one owner, or the gate cannot say whose it is.
   */
  tools?: Readonly<Record<string, ToolDef>>;
  /** The model's tool-choice policy while this persona is speaking. */
  toolChoice?: ToolChoice;
  /** The model's sampling temperature while this persona is speaking. */
  temperature?: number;
}

/**
 * Define a persona. An identity function, like {@link tool} and {@link subagent}:
 * it exists for the type, for the name to grep for, and so a persona is
 * declared at module scope where both the roster and a tool that hands off to
 * it can import it.
 *
 * @public
 */
export function persona(def: PersonaDef): PersonaDef {
  return def;
}

/** The name the model hands off by. @public */
export const HANDOFF_TOOL_NAME = "handoff";

/** Per-call options for {@link Personas.handoff}. @public */
export interface HandoffOptions {
  /**
   * What the next persona should know that the transcript does not say — "the
   * caller is verified", "wants a refund on invoice 4471". Rendered into the
   * new persona's prompt section until the next handoff, so it survives the
   * turn that made it rather than living only in one tool result.
   */
  note?: string;
}

/**
 * Where a session is, persona-wise — the position {@link Personas.position}
 * answers, the shape `DialogPosition` has for a dialog.
 *
 * @public
 */
export interface PersonaPosition {
  /** The persona speaking now. */
  readonly persona: PersonaDef;
  /** Who handed off to it, when a handoff has happened this session. */
  readonly from?: string;
  /** The {@link HandoffOptions.note} that came with that handoff. */
  readonly note?: string;
  /**
   * The dialog PINNING this persona, when a dialog state declares one. While a
   * pin is in force `handoff` to anyone else is refused — the state said who
   * speaks here, and the dialog moving is what releases it.
   */
  readonly pinnedBy?: { readonly dialog: string; readonly state: string };
}

/**
 * What a handoff returns — the shape a tool hands back as its result so the
 * model learns, in the same turn, who is speaking now.
 *
 * @public
 */
export interface HandoffResult {
  /** Always `true`: a discriminant a client or a spec can switch on. */
  readonly handoff: true;
  /** The persona that was speaking. */
  readonly from: string;
  /** The persona speaking now. */
  readonly to: string;
  /** The note that travelled with it, when one did. */
  readonly note?: string;
  /**
   * What the MODEL should do next, phrased for it: the tool result is the last
   * thing it reads before it speaks, and the persona section of its prompt has
   * already changed by the time it does.
   */
  readonly instruction: string;
}

/**
 * The roster the agent declares and every tool reaches for — what
 * {@link personas} returns.
 *
 * A HANDLE with methods that take the session, like {@link Dialog}, rather than
 * a bare array like `agent({ subagents })`: a handoff has to know the whole
 * roster to name who it came FROM and to refuse a target that is not on it, and
 * a bare array gives a tool body neither.
 *
 * @public
 */
export interface Personas {
  /** The roster, in declaration order. The first entry is the ENTRY persona. */
  readonly list: readonly PersonaDef[];
  /** Who is speaking, and how they came to be — see {@link PersonaPosition}. */
  position(ctx: SlotHolder): PersonaPosition;
  /** The persona speaking now: `position(ctx).persona`. */
  active(ctx: SlotHolder): PersonaDef;
  /**
   * Make `to` the speaker from the next model step on.
   *
   * Synchronous and cheap: one slot write. The prompt section, the pipeline's
   * `activeTools` and the gate all READ the slot at the next step, so the same
   * turn continues as the new persona — the model is told so through the
   * returned {@link HandoffResult.instruction}, which the calling tool should
   * return (or fold into) as its result.
   *
   * Throws when `to` is not on the roster, or when a dialog state currently
   * PINS another persona (see {@link PersonaPosition.pinnedBy}). Both are
   * authoring mistakes a tool body should not have to defend against; the
   * minted `handoff` tool turns them into a `ToolFailure` for the model.
   */
  handoff(ctx: SlotHolder, to: PersonaDef | string, options?: HandoffOptions): HandoffResult;
}

/**
 * The slot key. One per SESSION rather than per roster, because an agent
 * declares one roster — `agent({ personas })` is singular — and a second
 * `personas()` in the same process would then be reading the first one's slot,
 * which `claimKey` reports the moment the shapes disagree.
 *
 * @internal
 */
export const PERSONA_SLOT_KEY = "aai.persona";

/** What the slot stores: names, never defs — a def holds functions. */
interface HandoffRecord {
  /** The active persona's name, or `null` for the entry persona. */
  active: string | null;
  from: string | null;
  note: string | null;
}

const record = sessionSlot(
  PERSONA_SLOT_KEY,
  (): HandoffRecord => ({ active: null, from: null, note: null }),
);

/**
 * The dialogs `agent()` bound to each roster, so {@link Personas.position} can
 * honour a state's `persona` pin. A `WeakMap` keyed by the handle rather than a
 * field on it, because the handle is built at MODULE scope — before `agent()`
 * runs, and before the dialogs it will be declared beside exist — and because a
 * roster used by no agent should hold no reference to anything.
 */
const boundDialogs = new WeakMap<Personas, readonly AnyDialog[]>();

/** `agent()` calls this; see {@link boundDialogs}. @internal */
export function bindPersonaDialogs(roster: Personas, dialogs: readonly AnyDialog[]): void {
  boundDialogs.set(roster, dialogs);
}

/**
 * Declare the roster.
 *
 * Checked HERE, at module scope, rather than when `agent()` runs — every
 * refusal below reaches an author at the declaration, and each is a failure
 * with no symptom otherwise: two personas with one name route to whichever the
 * lookup finds; a tool two personas both declare is gated by whichever wrapper
 * landed last.
 *
 * @public
 */
export function personas(list: readonly PersonaDef[]): Personas {
  assertRoster(list);
  const entry = list[0] as PersonaDef;
  const byName = new Map(list.map((one) => [one.name, one]));

  const lookup = (name: string): PersonaDef => {
    const found = byName.get(name);
    if (found) return found;
    throw new Error(
      `There is no persona called "${name}" on this agent's roster. Declared: ${list.map((one) => one.name).join(", ")}.`,
    );
  };

  const pinned = (
    ctx: SlotHolder,
  ): { persona: PersonaDef; dialog: string; state: string } | undefined => {
    for (const dialog of boundDialogs.get(handle) ?? []) {
      const at = dialog.position(ctx);
      if (at.persona !== undefined) {
        return { persona: lookup(at.persona), dialog: dialog.key, state: at.state };
      }
    }
    return undefined;
  };

  const position = (ctx: SlotHolder): PersonaPosition => {
    const pin = pinned(ctx);
    const stored = record.get(ctx);
    if (pin) {
      return {
        persona: pin.persona,
        pinnedBy: { dialog: pin.dialog, state: pin.state },
      };
    }
    return {
      persona: stored.active === null ? entry : lookup(stored.active),
      ...omitUndefined({ from: stored.from ?? undefined, note: stored.note ?? undefined }),
    };
  };

  const handle: Personas = {
    list,
    position,
    active: (ctx) => position(ctx).persona,
    handoff(ctx, to, options = {}) {
      const target = lookup(typeof to === "string" ? to : to.name);
      const at = position(ctx);
      if (at.pinnedBy && at.persona.name !== target.name) {
        throw new Error(
          `Cannot hand off to "${target.name}": the "${at.pinnedBy.dialog}" dialog is in its "${at.pinnedBy.state}" state, which pins "${at.persona.name}". Move the dialog first.`,
        );
      }
      const from = at.persona.name;
      // Handing off to whoever is already speaking WRITES NOTHING: a write
      // would record a handoff from a persona to itself, and under a dialog
      // pin it would make the pinned persona outlive the pin.
      if (from === target.name) {
        return {
          handoff: true,
          from,
          to: target.name,
          ...omitUndefined({ note: options.note }),
          instruction: `You are already ${target.name}. Carry on.`,
        };
      }
      record.set(ctx, { active: target.name, from, note: options.note ?? null });
      return {
        handoff: true,
        from,
        to: target.name,
        ...omitUndefined({ note: options.note }),
        instruction: `You are now ${target.name}. From here on, speak and act as ${target.name}: follow that persona's instructions in your system prompt, and use its tools. Continue the conversation without restarting it.`,
      };
    },
  };
  return handle;
}

/**
 * Refuse a roster that cannot route. Each refusal stands in for a failure with
 * NO SYMPTOM — an agent that hands off to the wrong desk, or to one of two
 * identically-named ones, looks exactly like a model having a bad day.
 */
function assertRoster(list: readonly PersonaDef[]): void {
  if (list.length === 0) {
    throw new Error(
      "personas([]) declares a roster with nobody on it — the first entry is the persona that " +
        "answers the call. List the personas, or drop the roster.",
    );
  }
  const names = new Set<string>();
  const owners = new Map<string, string>();
  for (const one of list) {
    assertPersona(one);
    if (names.has(one.name)) {
      throw new Error(
        `Two personas on this roster are called "${one.name}". The name is what the model hands off ` +
          "by, so one of them has to be renamed.",
      );
    }
    names.add(one.name);
    for (const toolName of Object.keys(one.tools ?? {})) assertToolOwner(toolName, one, owners);
  }
}

/** The three fields a persona cannot route without, each refused by name. */
function assertPersona(one: PersonaDef): void {
  if (one.name.trim() === "") throw new Error("A persona needs a name.");
  if (one.description.trim() === "") {
    throw new Error(
      `The persona "${one.name}" has no \`description\`. That is the only thing the model reads ` +
        'when it picks who to hand off to — add a line saying what this one is FOR (e.g. "Invoices, payments and refunds").',
    );
  }
  if (one.systemPrompt.trim() === "") {
    throw new Error(
      `The persona "${one.name}" has no \`systemPrompt\`. A persona with no instructions of its own ` +
        "speaks exactly as the agent does, and a handoff to it changes nothing anyone can hear.",
    );
  }
}

/** One tool, one owner — and never the name the roster mints. */
function assertToolOwner(toolName: string, one: PersonaDef, owners: Map<string, string>): void {
  if (toolName === HANDOFF_TOOL_NAME) {
    throw new Error(
      `The persona "${one.name}" declares a tool called "${HANDOFF_TOOL_NAME}", which is the name of ` +
        "the tool the roster mints. Rename it.",
    );
  }
  const owner = owners.get(toolName);
  if (owner !== undefined) {
    throw new Error(
      `The tool "${toolName}" is declared by two personas, "${owner}" and "${one.name}". A tool has ` +
        "one owner — the gate has to know whose it is — so put it on the agent's tools/ if both need it.",
    );
  }
  owners.set(toolName, one.name);
}
