// Copyright 2026 the AAI authors. MIT license.
/**
 * The built-in tool vocabulary — the names `agent({ builtinTools })` accepts.
 *
 * Split out of `types.ts` when that file reached the 500-line cap; the seam is
 * the natural one, since nothing else in that module is about what runs on the
 * HOST rather than in the agent's own `tools/` directory. `types.ts` re-exports
 * the name, so an import of it is unchanged.
 */

/**
 * Identifier for a built-in server-side tool.
 *
 * Built-in tools run on the host process (not inside the sandboxed worker)
 * and provide capabilities like web search, code execution, and API access.
 *
 * - `"web_search"` — Search the web for current information, facts, or news.
 * - `"visit_webpage"` — Fetch a URL and return its content as clean text.
 * - `"get_page_design"` — Fetch a URL's raw HTML and CSS (markup, style blocks,
 *   linked stylesheets) to study or mimic a site's visual design.
 * - `"fetch_json"` — Call a REST API endpoint and return the JSON response.
 * - `"run_code"` — Execute JavaScript in a sandbox for calculations and data processing.
 * - `"think"` — Private no-op scratchpad for policy checks and planning (never spoken).
 * - `"remember"` — Save a confirmed fact (ID, code, date) to private session notes.
 * - `"recall"` — Read back facts saved with `remember`.
 * - `"calculate"` — Safely evaluate an arithmetic expression (no code execution).
 * - `"verify_action"` — Check a data-changing action against current state before
 *   taking it; reports a change that would be a no-op.
 * - `"listen_for"` — Bias the recognizer toward words the caller is about to
 *   say (a name, an order id), for the rest of the call.
 *
 * **`listen_for` is the one that is ON by default**, and it is the exception
 * that states the rule. Every other builtin gives the agent something to DO,
 * which is a decision about the product and so an author's; this one changes
 * only what the agent HEARS, and it is worth most precisely where nobody
 * thought to switch it on. Measured on tau2-bench retail: order ids survived
 * 41 renderings with one digit substitution while a caller's NAME collapsed
 * repeatedly and fatally ("Yusuf" → "Yuta" → "Yufus", three failed lookups and
 * a transfer to a human).
 *
 * **Naming ANY builtin replaces the default list, including this one** —
 * `builtinTools` is a list, not a patch, so `["think"]` means "think, and
 * nothing else". That is the existing semantics and it is not special-cased
 * here: an author who names their set has stated it, and a tool that could not
 * be switched off would be worse than one that has to be re-named. Write
 * `["think", "listen_for"]` to keep it.
 *
 * Otherwise a built-in is something an agent asks for rather than something it
 * has to notice and switch off. Name the ones you want; `[]` means none, and
 * differs from omitting the field.
 *
 * @public
 */
import { DEFAULT_BUILTIN_TOOLS } from "./constants.ts";

export type BuiltinTool =
  | "web_search"
  | "visit_webpage"
  | "get_page_design"
  | "fetch_json"
  | "run_code"
  | "think"
  | "remember"
  | "recall"
  | "calculate"
  | "verify_action"
  | "listen_for";

/**
 * The builtins an agent gets when it names none — filtered to the modes each
 * can actually work in.
 *
 * `listen_for` steers a RECOGNIZER, and only pipeline mode has one the runtime
 * can reach: text mode has no audio at all, and S2S runs recognition
 * service-side behind a socket exposing no such control (which is why
 * `ctx.steerRecognizer` answers `false` there). Offering it anyway would spend
 * the schema's tokens on every request a text agent makes and invite a call
 * that can only answer "this session's recognizer cannot be steered" —
 * advertising a capability the session does not have.
 *
 * An agent that NAMES a builtin still gets exactly what it named, in any mode:
 * that list is the author's statement, and the capability reports its own
 * failure honestly. What this filters is the DEFAULT, which is ours.
 *
 * @internal
 */
export function defaultBuiltinTools(agent: {
  text?: boolean | undefined;
  s2s?: unknown;
}): readonly BuiltinTool[] {
  const steerable = agent.text !== true && agent.s2s === undefined;
  return steerable
    ? DEFAULT_BUILTIN_TOOLS
    : DEFAULT_BUILTIN_TOOLS.filter((n) => n !== "listen_for");
}
