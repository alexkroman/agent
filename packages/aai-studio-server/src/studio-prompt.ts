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
 *
 * There is ONE prompt per {@link ProjectKind}: the preamble swaps its
 * mode-dependent fragments (`studio-preamble-mode.ts`) and the reference below
 * it is the same file either way — it documents both `agent()` and
 * `workflowApp()`, and a project that changes shape mid-conversation must not
 * lose half of it.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createLogger } from "aai-server/logger";
import { studioPreamble } from "./studio-preamble.ts";
import { DEFAULT_PROJECT_KIND, type ProjectKind } from "./studio-project-kind.ts";

const log = createLogger("studio.prompt");

/**
 * Compact fallback when the scaffold CLAUDE.md cannot be found on disk
 * (non-monorepo layouts). Enough to author a correct agent, minus the
 * long-form reference.
 */
const FALLBACK_GUIDE = `## agent() essentials

\`\`\`ts
// agent.ts — there is no \`tools\` field. A tool is a FILE.
import { agent } from "@alexkroman1/aai";

export default agent({
  name: "Support Agent",
  systemPrompt: "You are a concise, friendly voice support agent.",
  greeting: "Hi, how can I help?",
});
\`\`\`

\`\`\`ts
// tools/lookup_order.ts — the file name IS the name the model calls.
import { tool } from "@alexkroman1/aai";
import { z } from "zod";

export default tool({
  description: "Look up an order by id",
  inputSchema: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => \`Order \${orderId} is on its way\`,
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
- A FORM-fronted product (submit a job, watch it, read the result) is a
  workflow app instead: \`workflowApp({ name, workflows })\` with its bodies
  in \`workflows/*.ts\`, and a client.tsx mounted with \`mountPage()\`. It has no
  session, so systemPrompt/tools/providers are type errors on one.
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
 * `packages/aai-studio-server/src/aai-templates/...`, which does not exist — so
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

/** One composed prompt per project kind, built on first use. */
const cachedPrompts = new Map<ProjectKind, string>();

/** Read the scaffold authoring guide, or null when not on disk. */
export function loadScaffoldGuide(guidePath: string = scaffoldGuidePath()): string | null {
  try {
    return readFileSync(guidePath, "utf-8");
  } catch {
    return null;
  }
}

/** Pure composition: studio preamble for `kind` + guide (or the fallback). */
export function composeStudioPrompt(
  guide: string | null,
  kind: ProjectKind = DEFAULT_PROJECT_KIND,
): string {
  return studioPreamble(kind) + (guide ?? FALLBACK_GUIDE);
}

/**
 * Compose the studio system prompt for a project of this kind: studio
 * preamble + the CLI's scaffold CLAUDE.md (or the compact fallback). Cached
 * per kind — the guide is static for the process lifetime, and a studio
 * replica serves both kinds.
 *
 * Defaults to a voice agent, which is what every project written before the
 * new-project screen had a switcher is (see `resolveProjectKind`).
 */
export function studioSystemPrompt(kind: ProjectKind = DEFAULT_PROJECT_KIND): string {
  const cached = cachedPrompts.get(kind);
  if (cached !== undefined) return cached;
  const guide = loadScaffoldGuide();
  if (!guide) {
    log.warn("scaffold CLAUDE.md not found; using built-in authoring guide");
  }
  const prompt = composeStudioPrompt(guide, kind);
  cachedPrompts.set(kind, prompt);
  return prompt;
}

/** Test-only: clear the composed-prompt cache. */
export function _resetStudioPromptCache(): void {
  cachedPrompts.clear();
}
