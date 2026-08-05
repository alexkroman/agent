// Copyright 2025 the AAI authors. MIT license.
/**
 * System prompt for the studio's coding agent.
 *
 * The preamble (`studio-preamble.ts`) carries AssemblyAI Build's own rules
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
import { createRequire } from "node:module";
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
  inputSchema: z.object({ orderId: z.string() }),
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
- Pipeline mode is the default: declaring no providers gives the
  all-AssemblyAI pipeline (voice: "…" picks its TTS voice), and any subset
  of stt/llm/tts (factories from "@alexkroman1/aai/stt", "/llm", "/tts")
  swaps just those stages — the rest stay on the AssemblyAI default. The
  S2S voice agent API needs an explicit s2s: assemblyAIS2s(), and only
  when the user asks for it.

## Design guidelines (client.tsx)

- 3-5 colors total: one primary, 2-3 neutrals, at most 1-2 accents. No
  gradients unless asked; pair any overridden background with a text color.
- At most 2 font families; body text 14px+ with relaxed line height.
- Mobile-first flexbox layout, Tailwind spacing scale (p-4, never p-[16px]),
  gap-* between siblings rather than per-child margins.
- Semantic elements, alt text, sr-only labels on icon-only buttons; no
  emojis as icons, no decorative filler shapes.`;

/**
 * Locate the scaffold CLAUDE.md through the package graph, the same way
 * `studio-static.ts` finds the built studio client.
 *
 * This was a relative `../aai-templates/...` walk, justified by a comment
 * claiming the dev and built layouts both sit one directory under the package
 * root. They do not: from `dist/` it resolved to
 * `packages/aai-studio-server/aai-templates/...`, which does not exist — so
 * production (which runs the bundle) silently served FALLBACK_GUIDE and the
 * coding agent lost its entire SDK reference, with one console.warn as the
 * only signal. The test only exercised the dev layout, so it stayed green.
 *
 * Resolving through a real dependency edge cannot drift with the bundle's
 * location.
 */
export function scaffoldGuidePath(): string {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("aai-templates/package.json");
  return path.join(path.dirname(pkgPath), "scaffold", "CLAUDE.md");
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
