// Copyright 2026 the AAI authors. MIT license.
/**
 * The system prompt a session sends, in three parts.
 *
 * - The **base** is `buildSystemPrompt(agentConfig, …)` — fixed for the
 *   runtime's lifetime except for the date it stamps, and cached per calendar
 *   day for exactly that reason (see {@link createSystemPromptResolver}).
 * - The agent's own **instructions**, when `systemPrompt` is a RESOLVER rather
 *   than a string: asked once per model request and folded in under the same
 *   precedence header a static prompt gets. Nothing of it is on the wire — the
 *   config carries only the static half — so it cannot live in the base.
 * - The **suffix** is per TURN, resolved fresh every time a request is
 *   assembled, and empty on every session that ships today.
 *
 * It is its own module rather than two closures in `runtime.ts` because that
 * file is 5 lines under the 500-line cap and because the parts want different
 * lifetimes: the base belongs to the RUNTIME (one agent, many sessions), the
 * instructions resolver and the suffix to one SESSION. Written as one `let` beside the other
 * they read as the same scope, and a suffix accidentally hoisted to runtime
 * scope is one call's dialog phase leaking into every concurrent call — a bug
 * with no symptom on a machine running one session at a time.
 */

import type { AgentInstructions, AgentSessionContext } from "@alexkroman1/aai";
import { agentInstructionsSection, buildSystemPrompt } from "@alexkroman1/aai/host-internal";
import type { AgentConfig } from "@alexkroman1/aai/manifest";

/**
 * Between the base prompt and a non-empty suffix.
 *
 * A blank line, which is what `buildSystemPrompt` puts between its own
 * sections — a suffix is one more section, so it should not read as a
 * different KIND of text to the model than the ones above it.
 */
const SUFFIX_SEPARATOR = "\n\n";

/**
 * What a session appends to the base prompt, asked once per LLM request.
 *
 * Returning `""` is the no-op and costs nothing: {@link SessionSystemPrompt}
 * hands back the base string itself rather than a concatenation, so a phase
 * machine sitting in a state with nothing to say produces the byte-identical
 * prompt an agent without one produces.
 */
export type SystemPromptSuffix = () => string;

/** One session's prompt: the day-cached base plus whatever it appends. */
export interface SessionSystemPrompt {
  /**
   * The prompt for the request about to be assembled.
   *
   * Passed to a transport as the thunk half of `SystemPromptOption`, so the
   * pipeline resolves it at each turn. Cheap by construction — a cache lookup,
   * a suffix call and (only when the suffix is non-empty) one concatenation.
   */
  resolve(): string;
  /**
   * Install one of this session's suffix sources, under a KEY.
   *
   * **This is the extension point**, and what it exists for is the class of
   * fact the model can otherwise learn only from a tool RESULT: on a turn where
   * no tool ran, the agent answers with no idea where in the script it is.
   * Installing a suffix that renders the current state is what makes the prompt
   * state-addressed, and doing it here rather than by rebuilding the base keeps
   * the expensive half (the date stamp) cached.
   *
   * **It used to be unkeyed, last-writer-wins, on the argument that "a session
   * has one dialog, and a second installer is a wiring mistake rather than a
   * composition."** There are two legitimate installers now — the dialogs, and
   * the fast/slow tier's state digest — and under the old signature the second
   * silently deleted the first: a `dialog()` agent that also declared `twoTier`
   * lost its active instruction from every request, with nothing failing and no
   * way to see it short of reading the prompt on the wire.
   *
   * Rendered in KEY order (`localeCompare`), which is stable, has no dependency
   * on wiring order, and is the only ordering a reader of two prompts can
   * predict. Re-installing a key REPLACES it, so a re-wire on reconnect does
   * not accumulate.
   *
   * @param key who is contributing — `"dialogs"`, `"two-tier"`
   * @param suffix the source, asked once per request
   */
  setSuffix(key: string, suffix: SystemPromptSuffix): void;
}

/** The runtime-scoped prompt source: one base, one {@link SessionSystemPrompt} per session. */
export interface SystemPromptResolver {
  /** Today's base prompt. Exposed for the transports that cannot vary it per turn. */
  base(): string;
  /**
   * A fresh per-session resolver, starting with no suffix.
   *
   * The context is what an {@link AgentInstructions} resolver is called with —
   * this session's id, env and slots. Passed per SESSION rather than held on
   * the runtime for the reason the suffix is per session: a resolver reading
   * one call's slots and answering for another is the concurrency bug this
   * module's header describes, and it has no symptom on a machine running one
   * session at a time.
   */
  forSession(context: AgentSessionContext): SessionSystemPrompt;
}

/**
 * Build the runtime's prompt source.
 *
 * `buildSystemPrompt`'s inputs (agentConfig, tool presence, guidance) are all
 * fixed for the runtime's lifetime, but it stamps today's date via
 * `Intl.DateTimeFormat` — the most expensive thing on the session-start path
 * with no reason to be there. Cached per calendar day rather than hoisted
 * outright, so a replica that lives across midnight doesn't keep serving
 * yesterday's date. That optimisation is the reason the per-turn half is a
 * SUFFIX and not a rebuild: resolving a whole prompt per turn would pay the
 * format cost on every request instead of once a day.
 */
export function createSystemPromptResolver(deps: {
  agentConfig: AgentConfig;
  /** Does this runtime have any tool at all — declared or built-in? */
  hasTools: boolean;
  toolGuidance: readonly string[] | undefined;
  /**
   * The agent's `systemPrompt` when it is a RESOLVER rather than a string —
   * `systemPromptResolver(agent.systemPrompt)`.
   *
   * A THIRD part between the base and the suffix, not a replacement for either.
   * `toAgentConfig` puts nothing on the wire for a resolver, so the base carries
   * no agent-specific section for one, and this fills that section per request
   * under the same precedence header a static prompt gets
   * ({@link agentInstructionsSection}) — which is what makes a resolver and a
   * string land in the same place rather than merely near each other.
   *
   * Deliberately NOT `setSuffix`: that slot belongs to the session's dialogs,
   * last writer wins, and a session may legitimately have both.
   */
  instructions?: AgentInstructions | undefined;
}): SystemPromptResolver {
  let promptCache: { day: string; text: string } | null = null;

  function base(): string {
    const day = new Date().toDateString();
    // Keyed on the DAY alone, and that stays right with a resolver in play: the
    // base is built from the serialized config, which carries only the STATIC
    // half of `systemPrompt` — a resolver never reaches it (`toAgentConfig`
    // drops one) and is asked per request in `forSession` instead. So nothing
    // an author can vary is baked in here.
    if (promptCache?.day !== day) {
      promptCache = {
        day,
        text: buildSystemPrompt(deps.agentConfig, {
          hasTools: deps.hasTools,
          voice: true,
          toolGuidance: deps.toolGuidance,
        }),
      };
    }
    return promptCache.text;
  }

  return {
    base,
    forSession(context: AgentSessionContext): SessionSystemPrompt {
      const suffixes = new Map<string, SystemPromptSuffix>();
      return {
        resolve(): string {
          const dynamic = deps.instructions?.(context) ?? "";
          const text =
            dynamic === ""
              ? base()
              : `${base()}${SUFFIX_SEPARATOR}${agentInstructionsSection(dynamic)}`;
          // Each source is asked once per request, and an empty answer
          // contributes NOTHING — not a blank line, not a separator — which is
          // what keeps a session whose sources all have nothing to say
          // byte-identical to one with no sources at all.
          const extra = [...suffixes.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, render]) => render())
            .filter((part) => part !== "")
            .join(SUFFIX_SEPARATOR);
          // The identity return is load-bearing, not a micro-optimisation: with
          // no suffix installed this function IS `systemPromptForToday()`, so
          // every transport sends the same bytes it sent before this seam
          // existed. A separator appended to an empty suffix would change every
          // shipped agent's prompt by two characters.
          return extra.length === 0 ? text : `${text}${SUFFIX_SEPARATOR}${extra}`;
        },
        setSuffix(key: string, next: SystemPromptSuffix): void {
          suffixes.set(key, next);
        },
      };
    },
  };
}
