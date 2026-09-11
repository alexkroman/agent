// Copyright 2026 the AAI authors. MIT license.
/**
 * The two tiers' instructions, and the rule that governs every word of them.
 *
 * ## The litmus test — apply it to every sentence below, on every change
 *
 * **Could this sentence appear in a real call-center training manual written
 * before its author ever saw a benchmark?**
 *
 * That is Pickle's test, adopted from `docs/mentor-prompt-constitution.md` in
 * their tau2-bench fork, and it is the enforcement for the half of the
 * information boundary a type cannot reach. `view.ts` makes it impossible to
 * HAND the slow tier privileged information; nothing stops a prompt from
 * CARRYING it, and a prompt that does has smuggled the same advantage through
 * a different door.
 *
 * What fails the test, concretely: a tool name, a domain entity ("order",
 * "reservation", "roaming", "SIM"), a task family, a price or identifier
 * format, a known failure mode of a specific evaluation, or anything about a
 * simulated caller's mechanics (how it decides to hang up, how many times it
 * repeats itself, what its scenario does and does not tell it). Generic
 * customer-service vocabulary — customer, identifier, escalation, confirm — is
 * fine.
 *
 * What PASSES is a procedure over runtime state. Every domain fact either tier
 * uses has to arrive at runtime: through the agent's own instructions, the tool
 * descriptions, the conversation, or the digest. These prompts say how to
 * behave; they never say what is true.
 *
 * Pickle deliberately removed the static keyword test that used to guard this
 * and recorded why: prompt meaning is wording-sensitive, and a passing
 * blacklist creates false confidence — their own full-prompt review found
 * benchmark-shaped content in a prompt the test had accepted. So this is a
 * READING rule, and it sits above the strings rather than in a guide because
 * the next person to edit them should not have to go looking.
 *
 * Review the WHOLE text on a fresh read, never only the diff.
 *
 * @module
 */

import type { Message } from "@alexkroman1/aai";
import type { SlowTierView } from "./view.ts";

/**
 * What the FAST tier is told about the arrangement.
 *
 * Appended to the agent's own instructions, and short on purpose: it rides on
 * every request of a model chosen for its first-token latency, and the one
 * thing it has to achieve is that the fast tier does not claim work it cannot
 * do. The rest of its grounding is the digest section, which arrives beside
 * this and changes as the work does.
 *
 * **It describes no protocol for the fast tier to emit.** TalkAct's fast agent
 * emits `@slow:` directive lines and its own code carries three regexes to
 * strip the scaffolding small models echo into speech. Ours does not need one:
 * the runtime hears the caller directly and relays every committed utterance
 * itself, so there is no directive for a 4B model to forget, mangle, or say
 * out loud. See `session.ts`.
 */
export const FAST_TIER_INSTRUCTIONS = `You are speaking with the customer on a live call. A slower \
colleague is doing the actual work in the background; everything the customer tells you reaches them \
automatically, so you never need to repeat it to them or promise to pass it on.

You cannot carry out changes yourself. Your job is to keep the customer informed and comfortable: \
answer from the work status below, ask for anything the status says is still needed, and say plainly \
when something is still in progress. Keep replies short and natural for speech.

Never tell the customer that something has been done, changed, submitted, booked or cancelled unless \
the work status says it completed. If they ask whether it is finished and it is not, say what is \
still outstanding. If they want to wrap up while work is outstanding, tell them what is pending.`;

/**
 * What the SLOW tier is told.
 *
 * The shape is TalkAct's `SYSTEM_DUPLEX` — a division of labour, an
 * instruction to put every customer-relevant fact into the summary, and the
 * rule that personal data may only come from the conversation — restated
 * against this runtime's channel and re-read against the litmus test above.
 */
export const SLOW_TIER_SYSTEM_PROMPT = `You are the working half of a two-part assistant. A faster \
colleague is talking to the customer on a live call in real time. You do the actual work: you are \
the only one of the two who can use tools, so nothing happens unless you do it.

Division of labour:

- You carry out the work, using the tools you have.
- Your colleague handles the conversation. They answer the customer's questions from your summary \
and from nothing else, so put every fact the customer might ask about into it.
- Everything the customer says reaches you automatically as part of the conversation below. You do \
not need to ask your colleague for it.
- To have something said to the customer, use the tool that tells them something. To get an answer \
you need, use the tool that asks them — then keep working on whatever does not depend on it; their \
answer will appear in the conversation.
- When there is nothing left to do, use the tool that reports the work finished, and say in its \
result what the outcome was.

Rules:

- Never invent anything about the customer. Anything personal — names, dates, identifiers, \
preferences, amounts — must come from what they actually said. If you need something and it is not \
there, ask for it.
- Follow the instructions above exactly, including any order they require. Before doing anything \
that cannot be taken back, check that the instructions permit it and that the customer asked for it.
- Values reach you through speech recognition, so an identifier the customer stated may arrive with \
its separators, spacing or casing altered. If a lookup fails on a value they already gave you, try \
the other common renderings of it before asking them again.
- Every tool call requires a short summary of where the work stands. Write it for your colleague to \
read out: two to four sentences, factual and current, saying what has been done, what has not, and \
what is still needed. It is their only view of your work, so anything you leave out is something \
they cannot say.`;

/**
 * The description on the `state_summary` argument every slow-tier tool carries.
 *
 * TalkAct's `_SUMMARY_DESCRIPTIONS["standard"]`, rewritten to name no
 * benchmark. Its `"inventory"` and `"fulltext"` variants are not ported: both
 * exist to close a gap their report attributes to digest COMPRESSION on a
 * browser-driving slow tier reading a page of options, and neither is a
 * decision worth making before something here has measured the same gap.
 */
export const STATE_SUMMARY_DESCRIPTION =
  "REQUIRED on every call. A two-to-four sentence rolling summary of where the work stands: what " +
  "has been done, what page or record you are working in, the facts the customer might ask about " +
  "(options, amounts, names, values), and what you still need. Your colleague answers the " +
  "customer's questions ONLY from this summary, so keep it factual and current.";

function renderMessage(message: Message): string {
  if (message.role === "tool") {
    const name = message.toolName === undefined ? "TOOL" : `TOOL ${message.toolName}`;
    return `${name} RESULT: ${message.content}`;
  }
  return `${message.role === "user" ? "CUSTOMER" : "ASSISTANT"}: ${message.content}`;
}

/**
 * Render the view as the slow tier's opening message.
 *
 * ONE message rather than a growing conversation of its own, rebuilt on each
 * run from the session's current state. That is what keeps the slow tier's
 * context equal to the fast tier's rather than accumulating past it — the
 * information boundary is a property of this function as much as of the type.
 */
export function renderSlowTierBrief(view: SlowTierView): string {
  const catalog = view.catalog
    .map((t) => `- ${t.name}${t.mutates ? " (cannot be taken back)" : ""}: ${t.description}`)
    .join("\n");
  const conversation =
    view.conversation.length === 0
      ? "(nothing said yet)"
      : view.conversation.map(renderMessage).join("\n");
  const { summary, entries } = view.digest;
  const status =
    summary === "" && entries.length === 0
      ? "(nothing attempted yet)"
      : [
          ...(summary === "" ? [] : [summary]),
          ...entries.map((e) => `- ${e.tool}: ${e.state} ${e.note}`.trim()),
        ].join("\n");
  return [
    "YOUR INSTRUCTIONS FOR THIS ENGAGEMENT:",
    view.instructions,
    "",
    "TOOLS YOU HAVE:",
    catalog === "" ? "(none)" : catalog,
    "",
    "CONVERSATION SO FAR:",
    conversation,
    "",
    "WHERE THE WORK STANDS:",
    status,
    "",
    "Continue the work now. Stop when there is nothing left you can do without the customer.",
  ].join("\n");
}
