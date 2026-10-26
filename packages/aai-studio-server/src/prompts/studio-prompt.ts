// Copyright 2025 the AAI authors. MIT license.
/**
 * System prompt for the studio's coding agent.
 *
 * The preamble (`studio-preamble.ts`) carries AssemblyAI Build's own rules
 * in a v0-style arc — overview, workflow, guidelines, design, capabilities,
 * refusals, alignment examples. The authoring knowledge comes from
 * `aai-templates/scaffold/CLAUDE.md` — one source of truth for how to write
 * `agent.ts`, whether the coding agent is Claude Code on a laptop or the studio
 * in a browser. The two reach it differently: a laptop reads it out of the SDK
 * tarball (`AGENT_GUIDE.md`, where the scaffolded project's `CLAUDE.md`
 * points), while the studio has no `node_modules` to read and gets it inlined
 * here. The preamble overrides the parts that don't
 * apply here (the CLI dev loop, npm installs) and describes the studio's
 * own tools.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createLogger } from "aai-server/logger";
import { scaffoldDir } from "../studio-scaffold.ts";
import { studioPreamble } from "./studio-preamble.ts";

const log = createLogger("studio.prompt");

/**
 * Compact fallback when the scaffold CLAUDE.md cannot be found on disk
 * (non-monorepo layouts). Enough to author a correct agent, minus the
 * long-form reference.
 */
const FALLBACK_GUIDE = `## agent() essentials

\`\`\`ts
// agent.ts — there is no \`tools\` field (a tool is a FILE) and no
// \`systemPrompt\` field (the prompt is the system-prompt.md beside it).
import { agent } from "@alexkroman1/aai";

export default agent({
  name: "Support Agent",
  greeting: "Hi, how can I help?",
});
\`\`\`

\`\`\`md
<!-- system-prompt.md — the whole prompt, appended to the framework's voice rules -->
You are a concise, friendly voice support agent.
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
  session, so promptContext/providers are type errors on one and a
  system-prompt.md beside it is unread.
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

/** The scaffold's authoring guide — see {@link scaffoldDir} for how it is found. */
export function scaffoldGuidePath(): string {
  return path.join(scaffoldDir(), "CLAUDE.md");
}

/** The composed prompt, built on first use. */
let cachedPrompt: string | undefined;

/** The guide's topic directory, beside the core `CLAUDE.md`. */
const TOPIC_DIR = "agent-guide";

/**
 * Read the scaffold authoring guide, or null when its core is not on disk.
 *
 * The guide is a core `CLAUDE.md` plus topic files in `agent-guide/`. A laptop
 * agent reads a topic on demand; the studio's agent has no `node_modules` path
 * it can be told to read, so every topic is INLINED after the core, in the
 * order the core's routing table names them, each under a line saying which
 * file it is — so "read `agent-guide/TOOLS.md`" resolves to the section below.
 */
export function loadScaffoldGuide(guidePath: string = scaffoldGuidePath()): string | null {
  let core: string;
  try {
    core = readFileSync(guidePath, "utf-8");
  } catch {
    return null;
  }
  const dir = path.join(path.dirname(guidePath), TOPIC_DIR);
  let present: string[];
  try {
    present = readdirSync(dir).filter((name) => name.endsWith(".md"));
  } catch {
    return core;
  }
  const routed = [...core.matchAll(/agent-guide\/([A-Z][A-Z0-9-]*\.md)/g)].map((m) => m[1] ?? "");
  const order = [...new Set([...routed, ...present.sort()])].filter((name) =>
    present.includes(name),
  );
  const topics = order.map(
    (name) =>
      `\n\n<!-- ${TOPIC_DIR}/${name} — inlined; where the guide says to read ` +
      `\`${TOPIC_DIR}/${name}\`, this section is that file. -->\n\n` +
      readFileSync(path.join(dir, name), "utf-8"),
  );
  return core + topics.join("");
}

/** Pure composition: studio preamble + guide (or the fallback). */
export function composeStudioPrompt(guide: string | null): string {
  return studioPreamble() + (guide ?? FALLBACK_GUIDE);
}

/**
 * Compose the studio system prompt: studio preamble + the CLI's scaffold
 * CLAUDE.md (or the compact fallback). Cached — the guide is static for the
 * process lifetime.
 */
export function studioSystemPrompt(): string {
  if (cachedPrompt !== undefined) return cachedPrompt;
  const guide = loadScaffoldGuide();
  if (!guide) {
    log.warn("scaffold CLAUDE.md not found; using built-in authoring guide");
  }
  cachedPrompt = composeStudioPrompt(guide);
  return cachedPrompt;
}

/** Test-only: clear the composed-prompt cache. */
export function _resetStudioPromptCache(): void {
  cachedPrompt = undefined;
}
