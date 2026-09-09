/**
 * Run the agent from a terminal: `node chat.ts` (Node 24 runs TypeScript
 * directly), then type a request and press enter.
 *
 * A text agent has no session, so this file is its front door rather than
 * `aai dev`: `createRuntime` REFUSES `text: true` by name, because there are no
 * speech stages for a transport to sit between and no socket for a browser to
 * open. What runs it instead is `createTextAgent` — a message list and a model.
 * Everything else an agent has is the same code a voice agent runs: the tools,
 * the tool executor and its per-call deadline, `ctx`, the step budget, and the
 * last step reserved for an answer.
 *
 * Four lines are doing the interesting work:
 *
 * - `withToolsDir` is what makes a tool a FILE here. A deployed agent gets its
 *   tools from the bundler, which enumerates `tools/` at build time; a plain
 *   Node process has no bundler, so it reads the directory itself. Without it,
 *   `agent.ts`'s default export is an agent with no tools at all.
 * - `env` is where the LLM's credential is read from, and it is also what tool
 *   code sees as `ctx.env` — so pass what the agent needs and nothing else.
 * - `toolTimeoutMs` replaces the SDK's default of 30 seconds, which is a VOICE
 *   budget: past it a caller is listening to silence, so a slow tool is already
 *   a failed turn. Nobody is on a phone here, and a type check or an install is
 *   a minute of honest work.
 * - The conversation is a `ModelMessage[]` this file keeps. One `createTextAgent`
 *   is one conversation, and what carries the history between turns is the
 *   array — so this is also where you would trim it, persist it, or start over.
 */

import path from "node:path";
import { createInterface } from "node:readline/promises";
import { createTextAgent, withToolsDir } from "@alexkroman1/aai-runtime";
import agentDef from "./agent.ts";
import { WORKSPACE_DIR } from "./shared.ts";

const agent = await withToolsDir(agentDef, path.join(import.meta.dirname, "tools"));

const chat = createTextAgent({
  agent,
  env: { ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY ?? "" },
  toolTimeoutMs: 120_000,
});

// The turn's own message type, read off `stream` rather than imported from
// `ai` — a project scaffolded from this template declares the SDK packages and
// not the vendor's, and this needs no second dependency to say the same thing.
const messages: Parameters<typeof chat.stream>[0]["messages"] = [];
const io = createInterface({ input: process.stdin, output: process.stdout });
console.log(`Working in ${WORKSPACE_DIR}\n(ctrl-c to quit)\n`);

for (;;) {
  const line = (await io.question("> ")).trim();
  if (line.length === 0) continue;
  messages.push({ role: "user", content: line });
  const result = chat.stream({ messages });
  // Printed as it arrives: a turn that reads four files and edits two is a
  // long wait, and a spinner tells you less than the reply does.
  for await (const delta of result.textStream) process.stdout.write(delta);
  // Every message the turn produced — the assistant's own, plus one per tool
  // call and result — so the next turn sees what this one did.
  messages.push(...(await result.response).messages);
  process.stdout.write("\n\n");
}
