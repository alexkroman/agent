/**
 * A coding agent: it reads a codebase, changes it, and runs commands in it.
 *
 * `text: true` is the whole shape of it. A text agent has no audio path at all
 * — no microphone, no speech, no transport — so what runs it is
 * `createTextAgent` rather than a voice session, and a turn is a message in and
 * a reply out. That is the right mode for work measured in files rather than in
 * seconds of silence: a type check that takes 40 seconds is a fine tool call
 * here and a failed turn on a phone call.
 *
 * The tools are the nine in `tools/`, all of them the SDK's
 * (`@alexkroman1/aai/coding-tools`) over one directory — see `shared.ts` for
 * which directory, which is the one decision worth making deliberately before
 * running this.
 *
 * ## Making it yours
 *
 * - **`system-prompt.md` is the agent.** The tools are generic; how carefully
 *   it reads before it edits, whether it runs the tests, what it does when it
 *   is unsure — all of that is prose in that file, and it is where the first
 *   twenty edits go.
 * - **Add a tool by adding a FILE** to `tools/`. The nine here re-export a
 *   shared registry; yours is an ordinary `tool({ … })`, and the build
 *   enumerates the directory either way.
 * - **`maxSteps` is a budget for a whole task**, not a turn of conversation.
 *   Reading four files, editing two and running the tests is already eight
 *   calls, and the default (10) is sized for a voice agent's single answer.
 */

import { agent } from "@alexkroman1/aai";

export default agent({
  name: "Coding Agent",
  description: "Reads, edits and runs a codebase from a terminal chat",
  // No `llm` declared, so it runs the default AssemblyAI LLM gateway on
  // ASSEMBLYAI_API_KEY. Swap in `anthropicLlm({ model: "claude-opus-5" })` (or
  // any provider from `@alexkroman1/aai/llm`) when a task needs a stronger
  // model — the credential follows the descriptor.
  text: true,
  // Long, deliberately: a real change is read-read-edit-run-fix, and a budget
  // that runs out mid-task leaves a half-applied edit behind. The last step is
  // always spent ANSWERING rather than calling another tool, so a capped task
  // ends with the agent saying where it got to.
  maxSteps: 60,
});
