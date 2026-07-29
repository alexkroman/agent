// Copyright 2025 the AAI authors. MIT license.
/**
 * System prompt for the studio's coding agent.
 *
 * The authoring knowledge comes from the same `CLAUDE.md` the CLI scaffolds
 * into every `aai init` project (`aai-templates/scaffold/CLAUDE.md`) — one
 * source of truth for how to write `agent.ts`, whether the coding agent is
 * Claude Code on a laptop or the studio in a browser. A studio preamble
 * overrides the parts that don't apply here (CLI workflow, custom UI build,
 * npm installs) and describes the studio's own tools.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { ASSEMBLYAI_GATEWAY_MODELS } from "./studio-llm.ts";

const STUDIO_PREAMBLE = `You are the AAI Studio coding agent. You help the user build and deploy \
voice agents for the AAI platform, working on a small server-side workspace \
of files via your tools.

## Your workflow

1. Understand what the user wants; look at the current files first.
2. Edit agent.ts (and helper files) with write_file. Keep code simple.
3. Run test_agent to check your work builds and loads. Fix what it reports.
4. Tell the user it is ready and to hit Publish when they want it live.

You cannot publish. Publishing is the user's call, made with the Publish
button in the UI — there is no deploy tool, so never claim you deployed
anything or invent a live URL. Publishing seeds the agent's
ASSEMBLYAI_API_KEY automatically, so never ask the user for that key.

Be concise. Make the change, verify by re-reading only when unsure, and
summarize what you did in a sentence or two.

## Studio environment — where it differs from the CLI reference below

The framework reference that follows is the CLAUDE.md shipped to CLI
projects. Everything about agent.ts, agent(), tool(), ctx, providers,
built-in tools, KV, secrets, and voice prompt rules applies here too.
These CLI-specific parts do NOT apply in the studio:

- There is no shell, no pnpm, and no \`aai\` CLI. Ignore the "Workflow"
  and "CLI" sections — your loop is: edit files → test_agent → read the
  reported errors → fix → test again. The user publishes when ready.
- agent.ts and anything it imports are restricted to workspace files,
  "@alexkroman1/aai" (any subpath), and "zod". client.tsx may additionally
  import "@alexkroman1/aai-ui" and "react". No other npm packages can be
  installed.
- Custom client UI *is* supported: add a client.tsx (plus any helper files
  it imports, e.g. shared.ts) and publishing builds it with Vite, React,
  and Tailwind, exactly as the CLI does. Start it with
  \`import "@alexkroman1/aai-ui/styles.css";\` so Tailwind utilities work.
  Without a client.tsx the agent gets the default UI — only add one when
  the user wants custom UI.
- Do not add a vite.config.ts or index.html; the studio supplies both and
  ignores any you write.
- **Default to AssemblyAI for every provider.** ASSEMBLYAI_API_KEY is the
  one key a published agent is guaranteed to have (publishing seeds it), and
  it covers all three stages. Any other provider — Anthropic, OpenAI,
  Cartesia, Rime, Deepgram — needs a key the user has to supply, so an agent
  built on one cannot run until they do. Unless the user names a specific
  provider, choose:
    stt: assemblyAI({ model: "u3pro-rt" })       from "@alexkroman1/aai/stt"
    llm: assemblyAI({ model: "<gateway model>" }) from "@alexkroman1/aai/llm"
    tts: assemblyAI({ voice: "vera" })            from "@alexkroman1/aai/tts"
  The factory is named assemblyAI in all three subpaths — alias two on
  import. (S2S mode, i.e. no stt/llm/tts at all, is also all-AssemblyAI and
  remains the right default when the user just wants a voice agent.)
- **Never invent a gateway model id.** The LLM Gateway rejects unknown
  models with a 400 "model not found" that only shows up at runtime. Use one
  of exactly these: ${ASSEMBLYAI_GATEWAY_MODELS.join(", ")}. Prefer
  "gemini-2.5-flash-lite" for a fast, cheap voice agent.
- There is no .env file and you cannot set secrets. ASSEMBLYAI_API_KEY is
  handled automatically at publish time. If an agent's tools need a
  third-party key, say so and let the user supply it — do not ask them to
  paste it into the chat.
- agent.test.ts is not runnable here; skip tests unless the user plans to
  continue in the CLI.

# aai framework reference (scaffold CLAUDE.md)
`;

/**
 * Compact fallback when the scaffold CLAUDE.md cannot be found on disk
 * (non-monorepo layouts). Enough to author a correct agent, minus the
 * long-form reference.
 */
const FALLBACK_GUIDE = `## agent() essentials

\`\`\`ts
import { agent, tool } from "@alexkroman1/aai";
import { z } from "zod";

const lookup = tool({
  description: "Look up an order by id",
  parameters: z.object({ orderId: z.string() }),
  execute: async ({ orderId }, ctx) => \`Order \${orderId} is on its way\`,
});

export default agent({
  name: "Support Agent",
  systemPrompt: "You are a concise, friendly voice support agent.",
  greeting: "Hi, how can I help?",
  tools: { lookup_order: lookup },
});
\`\`\`

- Replies are spoken aloud: short sentences, no bullets/formatting, 1-3
  sentence answers, no exclamation points.
- Tool execute functions run sandboxed (no fs/subprocess; fetch is
  SSRF-proxied) and MUST return a value. ctx gives env, kv, messages,
  sessionId, send().
- Built-ins on by default: think, remember, recall, calculate. Opt-in via
  builtinTools: web_search, visit_webpage, fetch_json, run_code.
- Pipeline mode: set all three of stt/llm/tts (factories from
  "@alexkroman1/aai/stt", "/llm", "/tts") or none (S2S default).
- Text-only agent (speech in, text replies, no synthesis): pipeline mode
  with tts: none() from "@alexkroman1/aai/tts". No TTS key needed. The
  default UI becomes record button + audio-file upload + text replies;
  uploads under two minutes transcribe in one shot via AssemblyAI's Sync
  API automatically. Most text-only agents are one-shot transforms, not
  chat: transform each utterance/upload independently and output only
  the transformed result. holdPhrase is invalid with tts: none().
- Send channel: send: slack() from "@alexkroman1/aai/send" +
  SLACK_WEBHOOK_URL secret registers a send_message tool that posts to a
  Slack incoming webhook.`;

/**
 * Locate the scaffold CLAUDE.md. Both the dev source layout
 * (`packages/aai-server/studio/`) and the built layout
 * (`packages/aai-server/dist/`) sit one directory under the package root,
 * so a single relative path serves both; the Dockerfile ships the file at
 * the same relative location.
 */
function scaffoldGuidePath(): string {
  return path.resolve(import.meta.dirname, "../../aai-templates/scaffold/CLAUDE.md");
}

let cachedPrompt: string | undefined;

/** Read the scaffold authoring guide, or null when not on disk. */
export function loadScaffoldGuide(guidePath: string = scaffoldGuidePath()): string | null {
  try {
    return readFileSync(guidePath, "utf-8");
  } catch {
    return null;
  }
}

/** Pure composition: studio preamble + guide (or the compact fallback). */
export function composeStudioPrompt(guide: string | null): string {
  return STUDIO_PREAMBLE + (guide ?? FALLBACK_GUIDE);
}

/**
 * Compose the studio system prompt: studio preamble + the CLI's scaffold
 * CLAUDE.md (or the compact fallback). Cached — the guide is static for
 * the process lifetime.
 */
export function studioSystemPrompt(): string {
  if (cachedPrompt === undefined) {
    const guide = loadScaffoldGuide();
    if (!guide) {
      console.warn("Studio: scaffold CLAUDE.md not found; using built-in authoring guide");
    }
    cachedPrompt = composeStudioPrompt(guide);
  }
  return cachedPrompt;
}

/** Test-only: clear the composed-prompt cache. */
export function _resetStudioPromptCache(): void {
  cachedPrompt = undefined;
}
