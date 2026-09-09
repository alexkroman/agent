/**
 * Every prompt the assistant's MODELS read, and where each one comes from.
 *
 * **Adapted from LangChain's Executive AI Assistant** (MIT,
 * <https://github.com/langchain-ai/executive-ai-assistant>) — EAIA, the email
 * assistant that triages an inbox, drafts replies in its principal's voice,
 * halts on a human decision through the Agent Inbox, and rewrites its own
 * prompts from the corrections it gets. It is two LangGraph graphs and a cron,
 * and this file is the prompts of both, compressed for a phone:
 *
 * | EAIA | here |
 * | --- | --- |
 * | `triage.py` — `triage_prompt` + `RespondTo` | {@link triagePrompt} + {@link respondTo} |
 * | `fewshot.py` — similar triage examples from the store | {@link formatExamples}, over the session's own examples |
 * | `draft_response.py` — `EMAIL_WRITING_INSTRUCTIONS` | {@link draftingBrief}, the RESULT of `open_email` |
 * | `rewrite.py` — `rewrite_prompt` + `ReWriteEmail` | {@link rewritePrompt} + {@link reWriteEmail} |
 * | `find_meeting_time.py` — `meeting_prompts` | {@link meetingSystem}, a subagent's prompt |
 * | `reflection_graphs.py` — `CHOOSE_MEMORY_PROMPT`, `general_reflection_prompt` | {@link chooseMemoryPrompt}, {@link updateMemoryPrompt} |
 * | `reflection_graphs.py` — `MEMORY_TO_UPDATE*` | {@link MEMORY} |
 *
 * **Their drafting model's TOOLS became this agent's tools**, which is the one
 * move that decides the whole port. `draft_response` binds `ResponseEmailDraft`,
 * `NewEmailDraft`, `Question`, `MeetingAssistant`, `SendCalendarInvite` and
 * `Ignore` to a model with `tool_choice="required"`, and the tool call's
 * ARGUMENTS are the draft. A voice session already has a model choosing tools
 * every turn, so those six are `tools/` here — `draft_reply`, `new_email`,
 * `ask_question`, `meeting_assistant`, `send_calendar_invite`, `ignore` — and
 * `EMAIL_WRITING_INSTRUCTIONS` reaches it as the brief `open_email` hands back,
 * with the four memory prompts interpolated the way their store lookups do.
 *
 * **Each model role has its own `system` constant**, and that is a testing
 * decision as much as a prompting one: `stubGenerate` routes by system prompt,
 * so a spec can script the triage and the rewriter differently in one tool call
 * and fail NAMING the role when a tool reaches a model the script did not expect.
 */

import { z } from "zod";
import type { EXECUTIVE, Memory } from "./inbox.ts";

/** The principal, as every prompt names them. */
export type Executive = typeof EXECUTIVE;

/** Their `email_template` — a thread as every prompt here quotes it. */
export function threadText(email: {
  from: string;
  to: string;
  subject: string;
  body: string;
}): string {
  return `From: ${email.from}\nTo: ${email.to}\nSubject: ${email.subject}\n\n${email.body}`;
}

// ─── Triage ──────────────────────────────────────────────────────────────────

/** Their `RespondTo`. `question` routes exactly as `email` does, as their graph has it. */
export const respondTo = z.object({
  logic: z.string().max(400).describe("Logic on WHY the response choice is the way it is"),
  response: z.enum(["no", "email", "notify", "question"]),
});

export type TriageVerdict = z.infer<typeof respondTo>;

export const TRIAGE_SYSTEM = "You triage an executive's inbox.";

/** One remembered verdict, as their `triage_examples` namespace stores it. */
export interface TriageExample {
  emailId: string;
  subject: string;
  from: string;
  excerpt: string;
  result: "email" | "no";
}

/** Their `fewshot.py` template, over the examples {@link similarExamples} picked. */
export function formatExamples(examples: readonly TriageExample[]): string {
  if (examples.length === 0) return "";
  const rendered = examples.map(
    (eg) =>
      `Email Subject: ${eg.subject}\nEmail From: ${eg.from}\nEmail Content:\n` +
      `\`\`\`\n${eg.excerpt}\n\`\`\`\n> Triage Result: ${eg.result}`,
  );
  return ["Here are some previous examples:", ...rendered].join("\n\n------------\n\n");
}

const bullets = (lines: readonly string[]): string => lines.map((line) => `- ${line}`).join("\n");

/** Their `triage_prompt`, with the config and the examples filled in. */
export function triagePrompt(
  exec: Executive,
  email: { from: string; to: string; subject: string; body: string },
  examples: string,
): string {
  return [
    `You are ${exec.fullName}'s executive assistant. You are a top-notch executive assistant who cares about ${exec.name} performing as well as possible.`,
    "",
    `${exec.background}`,
    "",
    `${exec.name} gets lots of emails. Your job is to categorize the below email to see whether it is worth responding to.`,
    "",
    "Emails that are not worth responding to:",
    bullets(exec.triageNo),
    "",
    "Emails that are worth responding to:",
    bullets(exec.triageEmail),
    "",
    `There are also other things that ${exec.name} should know about, but don't require an email response. For these, you should notify ${exec.name} (using the \`notify\` response). Examples of this include:`,
    bullets(exec.triageNotify),
    "",
    `For emails not worth responding to, respond \`no\`. For something where ${exec.name} should respond over email, respond \`email\`. If it's important to notify ${exec.name}, but no email is required, respond \`notify\`.`,
    "",
    `If unsure, opt to \`notify\` ${exec.name} — you will learn from this in the future.`,
    "",
    examples,
    "",
    "Please determine how to handle the below email thread:",
    "",
    threadText(email),
  ].join("\n");
}

// ─── Drafting ────────────────────────────────────────────────────────────────

/**
 * Their `EMAIL_WRITING_INSTRUCTIONS`, as the brief `open_email` returns.
 *
 * Compressed to fit: a tool result is capped at 4000 characters and the thread
 * rides in the same result, so this keeps every RULE of theirs (no placeholders,
 * never agree to a meeting unasked, never invent an address, ask the meeting
 * assistant rather than the principal for free time) and drops the repetition a
 * chat model needed. The four memory prompts are interpolated exactly where
 * theirs are, which is what makes a reflection change the next draft.
 */
export function draftingBrief(exec: Executive, memory: Memory): string {
  const optional = (label: string, text: string) =>
    text.trim() === "" ? [] : [`${label}: ${text.trim()}`];
  return [
    `You are ${exec.fullName}'s executive assistant, helping ${exec.name} respond to this email. ${exec.background}`,
    "Choose ONE tool and CALL IT NOW, in this same turn, before you say anything to " +
      `${exec.name}. Speaking ends your turn: a sentence promising to check the calendar or ` +
      "draft a reply, with no tool behind it, is a promise you never keep.",
    `ask_question — when you lack information only ${exec.name} has. Never draft with a placeholder for a name, an email or a fact; ask instead. Never ask ${exec.name} when they are free — that is meeting_assistant's job.`,
    `draft_reply — when you have enough to respond. Write as ${exec.name}, never as an assistant. Add a new recipient only when ${exec.name} asked for it and you know the address; never invent one.`,
    `meeting_assistant — when a legitimate sender is trying to schedule a meeting. It reads ${exec.name}'s calendar and answers with the free slots. Not for a meeting already booked.`,
    `send_calendar_invite — only once you are sure ${exec.name} wants the meeting and the calendar is free. Pick the time yourself.`,
    `new_email — to start a new thread, such as an introduction ${exec.name} agreed to make.`,
    `ignore — only when ${exec.name} has said to skip this one.`,
    `Never agree to attend or meet unless ${exec.name} has explicitly okayed it. Never make things up.`,
    ...optional("Response preferences", memory.responsePreferences),
    ...optional("Scheduling preferences", memory.schedulePreferences),
    ...optional("Background", memory.backgroundPreferences),
  ].join("\n");
}

// ─── Rewrite ─────────────────────────────────────────────────────────────────

/** Their `ReWriteEmail`. */
export const reWriteEmail = z.object({
  toneLogic: z
    .string()
    .max(300)
    .describe("Logic for what the tone of the rewritten email should be"),
  rewrittenContent: z.string().max(4000).describe("Content rewritten with the new tone"),
});

export const REWRITE_SYSTEM = "You rewrite an email draft in its author's own voice.";

/** Their `rewrite_prompt`. */
export function rewritePrompt(
  exec: Executive,
  instructions: string,
  draft: string,
  thread: string,
): string {
  return [
    `Your job is to rewrite an email draft to sound more like ${exec.name}.`,
    "",
    `${exec.name}'s assistant just drafted an email. It is factually correct, but it may not sound like ${exec.name}. Your job is to rewrite the email keeping the information the same (do not add anything that is made up!) but adjusting the tone.`,
    "",
    instructions,
    "",
    "Here is the assistant's current draft:",
    "",
    `<draft>\n${draft}\n</draft>`,
    "",
    "Here is the email thread:",
    "",
    thread,
  ].join("\n");
}

// ─── The meeting assistant ───────────────────────────────────────────────────

/** Their `meeting_prompts`, minus the thread — that arrives as the subagent's task. */
export function meetingSystem(exec: Executive, today: string): string {
  return [
    `You are ${exec.fullName}'s executive assistant. The email thread you are given has been flagged as requesting time to meet. Your SOLE purpose is to survey ${exec.name}'s calendar and find times for ${exec.name}.`,
    `If the email suggests specific times, check whether ${exec.name} is available then. If it asks for time, use get_events_for_days to find valid times (always in ${exec.timezone}). Abide by any preferences the sender expressed, and never suggest a time they said would not work.`,
    "Send available spots in as big a chunk as possible: '1pm-3pm', never four half-hour slots. Do not send slots shorter than 15 minutes.",
    `Today is ${today}. Working hours are 9am to 5pm. Look up every day you mention before you mention it.`,
  ].join("\n");
}

export const MEETING_EXPECTED_OUTPUT =
  "One or two extremely dense sentences stating factually whether they are free and which " +
  "slots are open, e.g. 'Maya is not free Tuesday afternoon, but is free Wednesday 1pm-3pm.' " +
  "No greeting, no commentary, no reply to the email itself.";

// ─── Reflection ──────────────────────────────────────────────────────────────

/** Their `MEMORY_TO_UPDATE` keys — the four things a correction may teach. */
export const MEMORY_TYPES = ["tone", "email", "calendar", "background"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/**
 * Their three parallel tables (`MEMORY_TO_UPDATE`, `MEMORY_TO_UPDATE_KEYS`,
 * `MEMORY_TO_UPDATE_INSTRUCTIONS`) as one, so a type cannot be described in one
 * and keyed to nothing in another.
 */
export const MEMORY: Record<
  MemoryType,
  { key: keyof Memory; description: string; instructions: string }
> = {
  tone: {
    key: "rewriteInstructions",
    description:
      "Instruction about the tone and style and format of the resulting email. Update this if you learn new information about the tone in which the user likes to respond that may be relevant in future emails.",
    instructions:
      "Only update the prompt to include instructions on the **style and tone and format** of the response. Do NOT update the prompt to include anything about the actual content - only the style and tone and format. The user sometimes responds differently to different types of people - take that into account, but don't be too specific.",
  },
  email: {
    key: "responsePreferences",
    description:
      "Instructions about the type of content to be included in email. Update this if you learn new information about how the user likes to respond to emails (not the tone, and not information about the user, but specifically about how or when they like to respond to emails) that may be relevant in the future.",
    instructions:
      "Only update the prompt to include instructions on the **content** of the response. Do NOT update the prompt to include anything about the tone or style or format of the response.",
  },
  calendar: {
    key: "schedulePreferences",
    description:
      "Instructions about how to send calendar invites (including title, length, time, etc). Update this if you learn new information about how the user likes to schedule events that may be relevant in future emails.",
    instructions:
      "Only update the prompt to include instructions on how to send calendar invites - eg when to send them, what title should be, length, time of day, etc",
  },
  background: {
    key: "backgroundPreferences",
    description:
      "Background information about the user. Update this if you learn new information about the user that may be relevant in future emails",
    instructions:
      "Only update the prompt to include pieces of information that are relevant to being the user's assistant. Do not update the instructions to include anything about the tone of emails sent, when to send calendar invites. Examples of good things to include are (but are not limited to): people's emails, addresses, etc.",
  },
};

export const CHOOSE_MEMORY_SYSTEM =
  "You decide which of an assistant's prompts a correction should change.";

/** Their `determine_what_to_update` output. */
export const memoryToUpdate = z.object({
  memoryTypesToUpdate: z.array(z.enum(MEMORY_TYPES)),
});

/** Their `CHOOSE_MEMORY_PROMPT`. */
export function chooseMemoryPrompt(
  trajectory: string,
  feedback: string,
  types: readonly MemoryType[],
): string {
  const typesOfPrompts = types.map((t) => `\`${t}\`: ${MEMORY[t].description}`).join("\n");
  return [
    "You are helping an AI agent improve. You can do this by changing prompts.",
    "",
    "Here was the agent's trajectory:",
    `<trajectory>\n${trajectory}\n</trajectory>`,
    "",
    "Here is the user's feedback:",
    "",
    `<feedback>\n${feedback}\n</feedback>`,
    "",
    "These are the different types of prompts that you can update in order to change their behavior:",
    "",
    `<types_of_prompts>\n${typesOfPrompts}\n</types_of_prompts>`,
    "",
    "Please choose the types of prompts that are worth updating based on this trajectory + feedback. Only do this if the feedback seems like it has info relevant to the prompt. You will update the prompts themselves in a separate step. You do not have to update any memory types if you don't want to! Just leave it empty.",
  ].join("\n");
}

export const UPDATE_MEMORY_SYSTEM = "You rewrite one of an assistant's prompts from feedback.";

/** Their `GeneralResponse`. */
export const generalResponse = z.object({
  logic: z.string().max(400),
  updatePrompt: z.boolean(),
  newPrompt: z.string().max(4000),
});

/** Their `general_reflection_prompt`. */
export function updateMemoryPrompt(
  currentPrompt: string,
  trajectory: string,
  feedback: string,
  instructions: string,
): string {
  return [
    "You are helping an AI agent improve. You can do this by changing their system prompt.",
    "",
    "This is their current prompt:",
    `<current_prompt>\n${currentPrompt}\n</current_prompt>`,
    "",
    "Here was the agent's trajectory:",
    `<trajectory>\n${trajectory}\n</trajectory>`,
    "",
    "Here is the user's feedback:",
    "",
    `<feedback>\n${feedback}\n</feedback>`,
    "",
    "Here are instructions for updating the agent's prompt:",
    "",
    `<instructions>\n${instructions}\n</instructions>`,
    "",
    "Based on this, return an updated prompt.",
    "",
    "You should return the full prompt, so if there's anything from before that you want to include, make sure to do that. Feel free to override or change anything that seems irrelevant. You do not need to update the prompt - if you don't want to, just return `updatePrompt = false` and an empty string for the new prompt.",
  ].join("\n");
}

// ─── The voice agent's own prompt ────────────────────────────────────────────

/** Their `config.yaml` identity block, appended to `system-prompt.md` by `agent.ts`. */
export function principalBrief(exec: Executive): string {
  return [
    `You work for ${exec.fullName} — call them ${exec.name}. ${exec.background}`,
    `Their timezone is ${exec.timezone}; every time you say is in it.`,
  ].join("\n");
}
