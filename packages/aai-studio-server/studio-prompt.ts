// Copyright 2025 the AAI authors. MIT license.
/**
 * System prompt for the studio's coding agent.
 *
 * The preamble (`studio-preamble.ts`) carries the App Builder's own rules
 * in a v0-style arc — overview, workflow, guidelines, design, capabilities,
 * refusals, alignment examples. The authoring knowledge comes from the same
 * `CLAUDE.md` the CLI scaffolds into every `aai init` project
 * (`aai-templates/scaffold/CLAUDE.md`) — one source of truth for how to
 * write `agent.ts`, whether the coding agent is Claude Code on a laptop or
 * the studio in a browser. The preamble overrides the parts that don't
 * apply here (the CLI dev loop, npm installs) and describes the studio's
 * own tools.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { STUDIO_PREAMBLE } from "./studio-preamble.ts";

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
- Tool execute functions run sandboxed (no fs/subprocess) and MUST return
  a value. ctx gives env, db, messages, sessionId, send(). Tool code may
  fetch external APIs directly.
- Built-ins on by default: think, remember, recall, calculate. Opt-in via
  builtinTools: web_search, visit_webpage, get_page_design, fetch_json,
  run_code.
- Pipeline mode: set all three of stt/llm/tts (factories from
  "@alexkroman1/aai/stt", "/llm", "/tts") or none (the S2S voice agent
  API — only when the user asks for it). Every pipeline agent must name a
  real TTS provider.

## Design guidelines (client.tsx)

- 3-5 colors total: one primary, 2-3 neutrals, at most 1-2 accents. No
  gradients unless asked; pair any overridden background with a text color.
- At most 2 font families; body text 14px+ with relaxed line height.
- Mobile-first flexbox layout, Tailwind spacing scale (p-4, never p-[16px]),
  gap-* between siblings rather than per-child margins.
- Semantic elements, alt text, sr-only labels on icon-only buttons; no
  emojis as icons, no decorative filler shapes.`;

/**
 * Locate the scaffold CLAUDE.md. Both the dev source layout
 * (`packages/aai-server/studio/`) and the built layout
 * (`packages/aai-server/dist/`) sit one directory under the package root,
 * so a single relative path serves both; the Dockerfile ships the file at
 * the same relative location.
 */
function scaffoldGuidePath(): string {
  return path.resolve(import.meta.dirname, "../aai-templates/scaffold/CLAUDE.md");
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
