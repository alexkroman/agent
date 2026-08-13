// Copyright 2026 the AAI authors. MIT license.
/**
 * The product-shape half of the studio preamble: what KIND of thing to build
 * (a voice agent or a workflow app), where its data lives, and which providers
 * and models to reach for.
 *
 * Split out of `studio-preamble.ts` because that file is one 480-line template
 * literal against a 500-line cap, and these three sections are the ones that
 * move when the SDK does — they are also the only part of the preamble that
 * interpolates values read from the SDK itself. Composed back in at exactly
 * the position it was extracted from, so the prompt the agent sees is
 * unchanged.
 */

import { ASSEMBLYAI_LLM_DEFAULT_MODEL } from "@alexkroman1/aai/llm";
import { ASSEMBLYAI_GATEWAY_MODELS } from "./studio-llm.ts";

/** Sections: Voice Agents and Workflow Apps → Data Persistence → AI, Models, and Providers. */
export const STUDIO_SDK_GUIDANCE = `## Voice Agents and Workflow Apps

- **Default to a VOICE agent** — \`agent()\`, a microphone, a session. That is
  what someone asking for "an agent" means, and every guideline above about
  prompts, tools and spoken replies assumes it.
- **Build a WORKFLOW APP when the front door is a FORM rather than a call** —
  the user asks to submit a job, watch it run and read the result: an
  overnight digest, an upload that takes minutes, anything waiting on a
  third-party callback. Declare it with \`workflowApp({ name, workflows })\`
  from "@alexkroman1/aai" and mount its client.tsx with \`page()\` instead of
  \`client()\`. It has no session and no LLM loop, so systemPrompt, tools,
  maxSteps, state and every provider field are TYPE ERRORS on one — do not
  reach for \`agent({ page: "static" })\` and add them back.
- Workflow BODIES go in \`workflows/*.ts\` — the build transforms that
  directory and nothing else, so a \`"use workflow"\` body written in agent.ts
  runs inline with no durability and nothing reporting it. The body replays
  from the top on every resume (no fetch, no clock, no randomness — those go
  in a \`"use step"\` function), and a step gets no ctx: no ctx.env, no ctx.db.
- A workflow app NEEDS the database on, same as ctx.db: build it, then tell
  the user to enable it in Settings → Database. A voice agent can also start
  a run from a tool (\`ctx.workflows.start\`) and answer the turn — that is the
  other shape, and it stays an \`agent()\`.
- The reference below has the full section ("Workflow apps — workflowApp()"):
  the declaration, the body rules, the page, and the HTTP routes.

## Data Persistence and Storage

- \`ctx.state\` is session-scoped scratch — it does not survive the call.
  When the user asks for data that persists across calls, build on
  \`ctx.db\` (SQL with $1 placeholders); NEVER fake durable storage in
  session state.
- Parameterize every query — never interpolate user input into SQL.
- You cannot enable the database yourself, but the USER can, with one
  click: Settings pane → Database → Enable database. It covers both the
  preview and published agents (separate schemas). Build with ctx.db, then
  tell them to turn it on there — \`ctx.db\` throws until they do.
  (\`aai storage enable <slug>\` is the CLI equivalent; the pane is the
  answer for someone with no terminal.)

## AI, Models, and Providers

- **Default to a cascaded (pipeline-mode) agent with every stage on
  AssemblyAI — which means declaring no provider fields at all.** For every
  request that just asks for a voice agent — tools, state, personas and all:
    import { agent } from "@alexkroman1/aai";
    export default agent({ name: "…", voice: "jane" });
  An agent() with no stt/llm/tts runs the default AssemblyAI pipeline with
  real defaults for all three stages (universal-3-5-pro,
  ${ASSEMBLYAI_LLM_DEFAULT_MODEL}, jane), so
  there is no gateway model id to invent — an invented one is a 400 at the
  first session, with no compile-time or deploy-time check to catch it. The
  top-level \`voice\` field picks the default pipeline's TTS voice; do not
  add provider imports just to set a voice.
  To change a stage, declare just that field — every stage you leave unset
  stays on the AssemblyAI default:
    agent({ name: "…", tts: cartesia({ voice: "…" }) });
  The gateway LLM model works the same way — llm accepts the model id as a
  plain string:
    agent({ name: "…", llm: "claude-sonnet-4-6" });
  (\`voice\` is only for the default TTS — an explicit tts descriptor owns
  its own voice, and combining the two is a type error.)
  All default stages bill to ASSEMBLYAI_API_KEY, the one key a published
  agent is guaranteed to have, so this default runs the moment it is
  published. Any other provider — Anthropic, OpenAI, Cartesia, Rime,
  Deepgram — needs a key the user has to supply, so an agent built on one
  cannot run until they do. A provider, model, or voice the user *did* name
  wins for that stage, and the other stages still default to AssemblyAI.
  The explicit spelling of the all-AssemblyAI default is
  ...assemblyAIPipeline() (from "@alexkroman1/aai"); reach for it only when
  the user wants EU data residency (assemblyAIPipeline({ region: "eu" })).
- **Use the AssemblyAI voice agent API (S2S mode) only when the user asks
  for it** — "use the voice agent API", "S2S", "speech-to-speech", or the
  like. S2S is an explicit opt-in: set \`s2s: assemblyAIS2s()\` (imported
  from "@alexkroman1/aai", like the preset) and leave stt, llm, and tts
  unset; AssemblyAI then runs listening, thinking, and speaking end to end
  on the same key. Leaving all four provider fields unset does NOT select
  S2S — a provider-less agent() gets the pipeline default above injected —
  and there is no way to reach S2S by omission.
- **Never invent a gateway model id.** The LLM Gateway rejects unknown
  models with a 400 "model not found" that only shows up at runtime. Use one
  of exactly these: ${ASSEMBLYAI_GATEWAY_MODELS.join(", ")}. Prefer
  "${ASSEMBLYAI_LLM_DEFAULT_MODEL}" unless the user asks for a different model.
- For a one-shot LLM call inside a tool (summarize, classify, extract),
  use ctx.generate — see the reference below. Its \`schema\` option is
  a zod schema (typed structured output) or plain JSON Schema.`;
