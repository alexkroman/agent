// Copyright 2026 the AAI authors. MIT license.
/**
 * The system prompt a session sends, in two halves.
 *
 * - The **base** is `buildSystemPrompt(agentConfig, …)` — fixed for the
 *   runtime's lifetime except for the date it stamps, and cached per calendar
 *   day for exactly that reason (see {@link createSystemPromptResolver}). The
 *   one other thing that can move it is an agent whose own `systemPrompt` is a
 *   THUNK, which the cache keys on as well as the day: a base that ignored it
 *   would resolve the author's function once at boot and serve that answer for
 *   the life of the process, which is the whole thing a thunk is not.
 * - The **suffix** is per TURN, resolved fresh every time a request is
 *   assembled, and empty on every session that ships today.
 *
 * It is its own module rather than two closures in `runtime.ts` because that
 * file is 5 lines under the 500-line cap and because the two halves want
 * different lifetimes: the base belongs to the RUNTIME (one agent, many
 * sessions), the suffix to one SESSION. Written as one `let` beside the other
 * they read as the same scope, and a suffix accidentally hoisted to runtime
 * scope is one call's dialog phase leaking into every concurrent call — a bug
 * with no symptom on a machine running one session at a time.
 */

import type { SystemPromptOption } from "@alexkroman1/aai";
import { buildSystemPrompt } from "@alexkroman1/aai/host-internal";
import { resolveSystemPrompt } from "@alexkroman1/aai/internal";
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
   * Install this session's suffix source. **This is the extension point.**
   *
   * Nothing calls it yet. What will is the `dialog()` integration: a dialog
   * knows which phase the call is in and the model does not, because the only
   * way a phase reaches the model today is a tool RESULT — so on a turn where
   * no tool ran, the agent answers with no idea where in the script it is.
   * Installing a suffix that renders the current phase is what makes the prompt
   * state-addressed, and doing it here rather than by rebuilding the base keeps
   * the expensive half (the date stamp) cached.
   *
   * Last writer wins, deliberately: a session has one dialog, and a second
   * installer is a wiring mistake rather than a composition.
   */
  setSuffix(suffix: SystemPromptSuffix): void;
}

/** The runtime-scoped prompt source: one base, one {@link SessionSystemPrompt} per session. */
export interface SystemPromptResolver {
  /** Today's base prompt. Exposed for the transports that cannot vary it per turn. */
  base(): string;
  /** A fresh per-session resolver, starting with no suffix. */
  forSession(): SessionSystemPrompt;
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
  /**
   * The agent's own `systemPrompt` — a string, or the THUNK an `agent.ts` may
   * declare (`SystemPromptOption`). Defaults to the config's, which is the
   * snapshot `toAgentConfig` took of exactly this value: passing the live
   * definition is what makes a thunk answer per turn rather than once at boot.
   */
  systemPrompt?: SystemPromptOption;
  /** Does this runtime have any tool at all — declared or built-in? */
  hasTools: boolean;
  toolGuidance: readonly string[] | undefined;
}): SystemPromptResolver {
  let promptCache: { day: string; authored: string; text: string } | null = null;

  function base(): string {
    const day = new Date().toDateString();
    // The AUTHOR's prompt as it stands right now. A string resolves to itself,
    // so the comparison below is `===` on the same reference and this stays the
    // once-a-day build it was; a thunk is called per turn, and the assembled
    // prompt is rebuilt only when what it answers has actually moved — which is
    // what keeps the date stamp (the expensive half) off the per-turn path.
    const authored = resolveSystemPrompt(deps.systemPrompt ?? deps.agentConfig.systemPrompt);
    if (promptCache?.day !== day || promptCache.authored !== authored) {
      promptCache = {
        day,
        authored,
        text: buildSystemPrompt(
          { ...deps.agentConfig, systemPrompt: authored },
          {
            hasTools: deps.hasTools,
            voice: true,
            toolGuidance: deps.toolGuidance,
          },
        ),
      };
    }
    return promptCache.text;
  }

  return {
    base,
    forSession(): SessionSystemPrompt {
      let suffix: SystemPromptSuffix | null = null;
      return {
        resolve(): string {
          const text = base();
          const extra = suffix?.() ?? "";
          // The identity return is load-bearing, not a micro-optimisation: with
          // no suffix installed this function IS `systemPromptForToday()`, so
          // every transport sends the same bytes it sent before this seam
          // existed. A separator appended to an empty suffix would change every
          // shipped agent's prompt by two characters.
          return extra.length === 0 ? text : `${text}${SUFFIX_SEPARATOR}${extra}`;
        },
        setSuffix(next: SystemPromptSuffix): void {
          suffix = next;
        },
      };
    },
  };
}
