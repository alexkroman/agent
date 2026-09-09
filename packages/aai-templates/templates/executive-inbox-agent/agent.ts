import { agent } from "@alexkroman1/aai";
import { EXECUTIVE } from "./inbox.ts";
import { principalBrief } from "./prompts.ts";
import { assistantProjection, reviewFlow } from "./shared.ts";
import systemPrompt from "./system-prompt.md?raw";

/**
 * An executive assistant you phone about your inbox, adapted from LangChain's
 * Executive AI Assistant (EAIA). `prompts.ts` carries the attribution and the
 * table mapping their two graphs onto this template; `shared.ts` argues the
 * state and the dialog; `review.ts` is the human gate.
 *
 * **The whole port rests on one observation: their drafting model already
 * works by calling tools, so the voice model can BE that model.** Their
 * `draft_response` node binds six pydantic "tools" to an LLM with
 * `tool_choice="required"` and reads the chosen call's arguments as the draft.
 * A voice session has a model choosing tools every turn, so those six are this
 * agent's `tools/`, and the three nodes that are genuinely separate model calls
 * — triage, the tone rewrite, and reflection — run as `ctx.generate` inside
 * them. Their `find_meeting_time` is a ReAct agent over one calendar tool, and
 * so is a subagent here.
 *
 * **Their Agent Inbox interrupt is a spoken read-back with the same four
 * answers.** `accept`, `edit`, `ignore` and `respond` are tools gated on the
 * dialog's `awaitingDecision` state, and nothing is sent until `accept` has run —
 * which is the difference between an assistant that can send email in your name
 * and one that can do it by mistake. `dialogs` is declared so a hang-up moves
 * that gate to a final state with a draft still waiting in it.
 *
 * **And their reflection graphs are what make this more than a mail reader.**
 * Every correction — a redraft, a dictated replacement, an answer to a question
 * — runs their two-step reflection (which memories does this touch; rewrite
 * each) and writes the new prompts back into the session, so the next draft on
 * the same call is already different. The sidebar shows what was learned.
 */
export default agent({
  name: "Executive Assistant",
  description: "Triages an executive's inbox by phone and drafts the replies for their approval",
  // The voice rules in the file, plus who the principal is — their
  // `config.yaml`'s `full_name`, `name`, `background` and `timezone`, rendered
  // from the one place `inbox.ts` declares them so the prompt cannot name a
  // different executive than the triage does.
  systemPrompt: `${systemPrompt}\n\n${principalBrief(EXECUTIVE)}`,
  // The inbox, the memory and the proposal exist before the first tool call, so
  // a resumed connection has something to project.
  syncState: assistantProjection,
  // Declared so the CALL can move the gate: a caller who hangs up with a draft
  // waiting leaves `accept` legal for the rest of the session otherwise.
  dialogs: [reviewFlow],
  greeting: `Morning, ${EXECUTIVE.name}. I have your inbox up — shall I run through what came in?`,
});
