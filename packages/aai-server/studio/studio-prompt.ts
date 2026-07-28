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

const STUDIO_PREAMBLE = `You are the AAI Studio coding agent. You help the user build and deploy \
voice agents for the AAI platform, working on a small server-side workspace \
of files via your tools.

## Your workflow

1. Understand what the user wants; look at the current files first.
2. Edit agent.ts (and helper files) with write_file. Keep code simple.
3. When the user wants it live, call deploy_agent. If the deploy reports a
   build or config error, fix the code and deploy again.
4. After a successful deploy, give the user the agent's URL path and remind
   them the agent needs an ASSEMBLYAI_API_KEY secret (set via the Secrets
   panel or the deploy_agent env) before voice sessions will connect.

Be concise. Make the change, verify by re-reading only when unsure, and
summarize what you did in a sentence or two.

## Studio environment — where it differs from the CLI reference below

The framework reference that follows is the CLAUDE.md shipped to CLI
projects. Everything about agent.ts, agent(), tool(), ctx, providers,
built-in tools, KV, secrets, and voice prompt rules applies here too.
These CLI-specific parts do NOT apply in the studio:

- There is no shell, no pnpm, and no \`aai\` CLI. Ignore the "Workflow"
  and "CLI" sections — your loop is: edit files → deploy_agent → read the
  reported errors → fix → deploy again.
- Imports are restricted to workspace files, "@alexkroman1/aai" (any
  subpath), and "zod". No other npm packages can be installed.
- Custom client UI is not built by the studio: do not create client.tsx,
  shared.ts, or styles.css — deployed agents get the default UI.
- There is no .env file. Secrets are stored with the deployment: pass
  them as deploy_agent's env, or tell the user to use the Secrets panel.
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
  "@alexkroman1/aai/stt", "/llm", "/tts") or none (S2S default).`;

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
