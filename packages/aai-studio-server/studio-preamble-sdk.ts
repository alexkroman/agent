// Copyright 2026 the AAI authors. MIT license.
/**
 * The SDK-derived half of the studio preamble: where an agent's data lives,
 * and which providers and models to reach for.
 *
 * Split out of `studio-preamble.ts` because that file is one 480-line template
 * literal against a 500-line cap, and these sections are the ones that move
 * when the SDK does — they are also the only part of the preamble that
 * interpolates values read from the SDK itself. Composed back in at exactly
 * the position it was extracted from, so the prompt the agent sees is
 * unchanged.
 *
 * The product-shape section that used to open this file ("Voice Agents and
 * Workflow Apps") is now MODE-DEPENDENT and lives in `studio-preamble-mode.ts`,
 * composed in immediately before this text — a workflow project's coding agent
 * must not read "default to a VOICE agent". Everything here is shared by both
 * modes, the provider rules included: "actually make it a voice agent" is one
 * message away in either project.
 */

import { ASSEMBLYAI_LLM_DEFAULT_MODEL } from "@alexkroman1/aai/llm";
import { ASSEMBLYAI_GATEWAY_MODELS } from "./studio-llm.ts";

/** Sections: Data Persistence → AI, Models, and Providers. */
export const STUDIO_SDK_GUIDANCE = `## Data Persistence and Storage

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
