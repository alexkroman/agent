// Copyright 2026 the AAI authors. MIT license.
/**
 * A PHONE TREE an eval session can be put through: an automated menu that
 * plays its prompt, waits for keys, and follows them to the next menu — until
 * the call is put through to whoever answers at the end.
 *
 * Every agent that places calls meets one, and every eval of that agent had to
 * hand-script the walk: say the first prompt, read which key the model chose
 * out of a tool's ARGUMENTS, pick the next prompt by hand, repeat. That breaks
 * in the two places a phone menu is hard. A wrong key still advanced the script
 * (it was written for the right one), and the tool's name was baked into every
 * case. {@link walkPhoneTree} plays the tree as DATA and follows what the agent
 * actually pressed (`EvalTurn.dtmf`, read off the session), so a wrong key
 * replays the menu as a real one would, and any tool that calls `sendDtmf`
 * works.
 *
 * ```ts
 * import { type EvalSession, type PhoneTree, walkPhoneTree } from "@alexkroman1/aai-runtime/eval";
 *
 * declare const session: EvalSession; // `openEvalSession`'s, or a `describeEval` case's
 *
 * const tree: PhoneTree = {
 *   name: "main",
 *   prompt: "For billing, press 1. For appointments, press 2.",
 *   options: {
 *     "1": { name: "billing", prompt: "Billing, this is Sam." },
 *     "2": {
 *       name: "extension",
 *       prompt: "Enter the extension of the person you are calling, then pound.",
 *       options: { "204": { name: "front desk", prompt: "Front desk, this is Dana." } },
 *     },
 *   },
 * };
 * const walk = await walkPhoneTree(session, tree);
 * if (walk.reached !== "front desk") throw new Error(`took ${JSON.stringify(walk.path)}`);
 * ```
 *
 * **What it does not simulate**: anything below the audio boundary. A press
 * here is a recorded string, so tones the carrier drops, a barge-in that cuts
 * the tones off, and a transcriber that mishears the menu are a real call's
 * subject, as for every text-driven eval.
 *
 * @module
 */

import type { EvalSession, EvalTurn } from "./session-types.ts";

/**
 * Where a phone tree ends: whoever the menu puts the call through to — a
 * person picking up, a voicemail greeting, a recorded "we are closed".
 *
 * @input
 * @public
 */
export type PhoneTreeLeaf = {
  /** Names the leaf in {@link PhoneTreeWalk.reached}. */
  readonly name: string;
  /** What is said once the call is put through. The agent's reply to it is the walk's last turn. */
  readonly prompt: string;
};

/**
 * One automated menu: a prompt, and where each entry leads.
 *
 * @input
 * @public
 */
export type PhoneMenu = {
  /** Names the menu in {@link PhoneTreeStep.menu}. */
  readonly name: string;
  /** What the menu says each time it plays. */
  readonly prompt: string;
  /**
   * Each whole ENTRY and where it leads: `"2"` for a one-key choice, `"204"`
   * for an extension. A trailing `#` on what was pressed counts as the
   * entry's terminator (`"204#"` matches `"204"`) unless the entry names it
   * itself. Anything else is not an entry, and the menu replays.
   */
  readonly options: Readonly<Record<string, PhoneTree>>;
};

/**
 * A menu or the leaf it ends in — the tree {@link walkPhoneTree} plays.
 *
 * @public
 */
export type PhoneTree = PhoneMenu | PhoneTreeLeaf;

/**
 * One menu played: what the agent pressed after hearing it, and where that led.
 *
 * @sealed
 * @public
 */
export type PhoneTreeStep = {
  /** The {@link PhoneMenu.name} that played. */
  readonly menu: string;
  /** Every key the agent pressed on that turn, joined, pauses dropped. `""` when it pressed nothing. */
  readonly pressed: string;
  /** The name of the node the entry led to; `undefined` when it matched none and the menu replayed. */
  readonly next: string | undefined;
};

/**
 * What {@link walkPhoneTree} saw.
 *
 * @sealed
 * @public
 */
export type PhoneTreeWalk = {
  /** The {@link PhoneTreeLeaf.name} the agent got through to; `undefined` when it never did. */
  readonly reached: string | undefined;
  /** Every menu played, in order, with what was pressed. */
  readonly path: readonly PhoneTreeStep[];
  /** Every turn the walk drove, in order. The leaf's is last, so a case can read the agent's greeting to whoever picked up. */
  readonly turns: readonly EvalTurn[];
  /**
   * Why the walk ended short of a leaf: the agent hung up, or the menus played
   * {@link WalkPhoneTreeOptions.maxPrompts} times. `undefined` when it reached one.
   */
  readonly stopped: "hung-up" | "max-prompts" | (string & {}) | undefined;
};

/**
 * Knobs for {@link walkPhoneTree}.
 *
 * @input
 * @public
 */
export type WalkPhoneTreeOptions = {
  /** Most menu prompts played before the walk gives up — where an agent looping on a wrong key ends. Default 10. */
  readonly maxPrompts?: number;
  /** Said before the menu replays after an entry it has no option for. */
  readonly invalidPrefix?: string;
  /** Said before the menu replays after the agent pressed nothing. */
  readonly noInputPrefix?: string;
};

const DEFAULT_MAX_PROMPTS = 10;
const DEFAULT_INVALID_PREFIX = "Sorry, that is not a valid option.";
const DEFAULT_NO_INPUT_PREFIX = "Sorry, I didn't get your selection.";

function isMenu(node: PhoneTree): node is PhoneMenu {
  return "options" in node;
}

/** The node `entry` selects in `menu`, with a trailing `#` read as the terminator. */
function select(menu: PhoneMenu, entry: string): PhoneTree | undefined {
  const exact = Object.hasOwn(menu.options, entry) ? menu.options[entry] : undefined;
  if (exact !== undefined || !entry.endsWith("#")) return exact;
  const bare = entry.slice(0, -1);
  return Object.hasOwn(menu.options, bare) ? menu.options[bare] : undefined;
}

/** What the agent pressed on `turn`, joined and without pauses — or a throw naming the harness that cannot say. */
function pressedOn(turn: EvalTurn): string {
  if (turn.dtmf === undefined) {
    throw new TypeError(
      "walkPhoneTree: this turn carries no `dtmf`, so nothing can say what the agent " +
        "pressed. Walk a session from `openEvalSession` / `describeEval`, or set `dtmf` " +
        "on the turns your own harness builds.",
    );
  }
  return turn.dtmf.join("").replaceAll("w", "");
}

/** Every menu in `tree` must offer something, or the walk could only replay it. */
function assertWalkable(tree: PhoneTree): void {
  if (!isMenu(tree)) return;
  const entries = Object.entries(tree.options);
  if (entries.length === 0) {
    throw new TypeError(`walkPhoneTree: menu "${tree.name}" has no options to press.`);
  }
  for (const [, next] of entries) assertWalkable(next);
}

/**
 * What one played menu came to: the step for the path, the node the entry
 * selected, and — when it selected none — what the menu says before replaying.
 */
function answer(
  menu: PhoneMenu,
  turn: EvalTurn,
  options: WalkPhoneTreeOptions,
): { step: PhoneTreeStep; next: PhoneTree | undefined; replayPrefix: string } {
  const pressed = pressedOn(turn);
  const next = pressed === "" ? undefined : select(menu, pressed);
  const replayPrefix =
    pressed === ""
      ? (options.noInputPrefix ?? DEFAULT_NO_INPUT_PREFIX)
      : (options.invalidPrefix ?? DEFAULT_INVALID_PREFIX);
  return { step: { menu: menu.name, pressed, next: next?.name }, next, replayPrefix };
}

/**
 * Put an eval session through `tree`: play each menu's prompt as the caller's
 * side of the line, follow the keys the agent pressed, and stop at the leaf it
 * got through to — whose prompt is said too, so the agent's reply to the
 * person who picked up is the last of {@link PhoneTreeWalk.turns}.
 *
 * A real menu's two non-answers are played as one: an entry with no option
 * replays the menu after {@link WalkPhoneTreeOptions.invalidPrefix}, and a turn
 * that pressed nothing (the agent spoke to the menu, or waited) after
 * {@link WalkPhoneTreeOptions.noInputPrefix}. Entries are matched WHOLE, which is
 * stricter than a menu reading one key at a time: `"21"` where `"2"` was the
 * option is a wrong entry here, because a model that typed it would be
 * talking into the next menu on a real line.
 *
 * Returns rather than throws when the agent never gets through, so a case can
 * assert on the path it took instead of on a message.
 *
 * @param session - an {@link EvalSession}, or anything whose `say()` answers
 *   turns that carry `dtmf`.
 * @throws TypeError when a menu has no options, or a turn carries no `dtmf`.
 * @public
 */
export async function walkPhoneTree(
  session: Pick<EvalSession, "say">,
  tree: PhoneTree,
  options: WalkPhoneTreeOptions = {},
): Promise<PhoneTreeWalk> {
  assertWalkable(tree);
  const maxPrompts = options.maxPrompts ?? DEFAULT_MAX_PROMPTS;
  const path: PhoneTreeStep[] = [];
  const turns: EvalTurn[] = [];
  let node = tree;
  let prefix = "";
  for (let played = 0; played < maxPrompts || !isMenu(node); played++) {
    const turn = await session.say(prefix === "" ? node.prompt : `${prefix} ${node.prompt}`);
    turns.push(turn);
    if (!isMenu(node)) return { reached: node.name, path, turns, stopped: undefined };
    const { step, next, replayPrefix } = answer(node, turn, options);
    path.push(step);
    if (turn.endedSession === true) return { reached: undefined, path, turns, stopped: "hung-up" };
    node = next ?? node;
    prefix = next === undefined ? replayPrefix : "";
  }
  return { reached: undefined, path, turns, stopped: "max-prompts" };
}
