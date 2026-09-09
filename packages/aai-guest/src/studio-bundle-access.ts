// Copyright 2026 the AAI authors. MIT license.
/**
 * The two capabilities the studio coding agent borrows from the harness itself:
 * this harness's own bundle loader and its one-shot trial executor.
 *
 * `test_agent` is built out of exactly this pair — build the workspace, load the
 * bundle, report its config, optionally invoke one of its tools — and
 * `HarnessBundleAccess` has been the one declaration of the SHAPE since it was
 * written out at three call sites. What had no single declaration was the
 * IMPLEMENTATION: `harness.ts` built the object inline, and the two rules inside
 * it are not obvious from the type. A trial load carries an EMPTY env (a
 * studio inspection must not fail on a credential the deployed agent will
 * resolve later), and a trial tool call answers in PROSE — "Tool error: …",
 * "(no result)", "agent not loaded" — because its consumer is a model reading a
 * tool result, not a caller catching an exception.
 *
 * So it is a function now, and the studio eval harness
 * (`_studio-eval-harness.ts`) is what made that worth doing: a second caller
 * that wants the REAL pair rather than a double is the point at which an inline
 * object becomes a copy, and a copy of these two rules is a copy that can come
 * to disagree about what a failed trial says.
 *
 * @module
 */

import { type HarnessState, loadBundle } from "./harness-bundle.ts";
import type { HarnessBundleAccess } from "./harness-types.ts";
import { executeTool } from "./trial.ts";

/** The sessionId a trial tool call runs under — there is no session. */
const TRIAL_SESSION_ID = "studio-trial";

/**
 * The studio's view of `state`'s loader and trial executor.
 *
 * Reads `state` on every call rather than closing over its fields: a load
 * REPLACES `state.agent`, and `test_agent` loads and then trials in the same
 * tool call, so a snapshot taken when this object was built would trial the
 * previously loaded agent (or none at all).
 */
export function studioBundleAccess(state: HarnessState): HarnessBundleAccess {
  return {
    // An inspection load: empty env, because the bundle's own provider
    // credentials are resolved when a real session starts and a studio load
    // must not fail for want of them.
    loadBundle: (code: string) => loadBundle(state, { code, env: {} }),
    executeTool: async (name: string, args: Record<string, unknown>) => {
      if (!state.agent) return "Tool error: agent not loaded";
      const response = await executeTool(
        state.agent,
        { name, args, sessionId: TRIAL_SESSION_ID, state: null },
        { env: state.env },
      );
      if (response.error) return `Tool error: ${response.error}`;
      return response.result ?? "(no result)";
    },
  };
}
