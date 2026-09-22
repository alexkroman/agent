// Copyright 2026 the AAI authors. MIT license.
/**
 * Studio size limits, in their own dependency-free module — the single
 * home for the studio's workspace/chat caps. Kept import-free so any
 * consumer (schemas, the workspace store, the session broker) can load
 * them without dragging zod along. The workspace FILE caps are no longer
 * declared here: they belong to the shared workspace contract in the SDK and
 * are re-exported below, so the three sides that must agree on them read one
 * definition.
 */

/**
 * The workspace file caps — RE-EXPORTED from the SDK
 * (`@alexkroman1/aai/workspace-files`), which also owns the walk and skip
 * rules the CLI's push and the guest's sync share. Validation here has to
 * accept exactly what those two produce, so it reads the same constants
 * rather than restating them.
 */
export {
  MAX_WORKSPACE_FILE_BYTES as MAX_STUDIO_FILE_BYTES,
  MAX_WORKSPACE_FILES as MAX_STUDIO_FILES,
} from "@alexkroman1/aai/workspace-files";
/** Max total bytes across a workspace (guards the single-doc storage model). */
export const MAX_STUDIO_WORKSPACE_BYTES = 50_000_000;
/** Max messages accepted per chat turn (client resends full history). */
export const MAX_STUDIO_CHAT_MESSAGES = 80;
/**
 * Max serialized bytes for a single chat message. Sized so an assistant
 * message carrying a couple of full-file tool outputs still fits.
 */
export const MAX_STUDIO_MESSAGE_BYTES = 600_000;
/**
 * Steps one chat turn may take.
 *
 * Was 16, which the starter evals showed was the dominant cause of failure:
 * turns died mid-repair (build → read error → edit → build) with a broken
 * workspace, not because the agent was lost but because it ran out of room.
 * opencode allows ~1000 and summarizes as it approaches the context limit;
 * this is the same trade at a more conservative ceiling, paired with
 * compaction in the guest (studio/compaction.ts) so the extra steps are
 * actually reachable.
 *
 * A runaway turn is still bounded — by this cap, by each tool's own deadline,
 * and by the client's Stop button.
 */
export const MAX_CHAT_STEPS = 80;

/**
 * Output tokens one model call may produce.
 *
 * **Unset is not "no limit" — it is the PROVIDER's default**, and that is the
 * trap this constant exists to close. The studio agent set no
 * `maxOutputTokens` at all, so every step ran against whatever ceiling the
 * gateway picked, and a step that writes a whole source file inside a
 * tool-call argument is exactly the shape that reaches one.
 *
 * What makes reaching it expensive is a change in `ai@7.0.70`
 * (`isToolExecutionAllowedFinishReason`): tool calls are now executed ONLY
 * when the step finished `stop` or `tool-calls`. A step truncated at the
 * output limit finishes `length`, so its tool call is silently dropped — no
 * tool result, therefore no continuation, therefore the turn ends on a
 * half-written sentence with the work not done. Before that version the call
 * still ran. That is the regression behind "it worked before the upgrade",
 * and the failure is invisible from the outside: the agent simply stops.
 *
 * 32k is generous against the job rather than against the model — 32k tokens
 * is ~128 KB of output, far more than any file the agent writes in one step —
 * and deliberately NOT each model's true ceiling, because the gateway serves
 * a catalog (`STUDIO_LLM_MODELS`) whose smaller members would 400 on a value
 * sized for the largest. `STUDIO_MAX_OUTPUT_TOKENS` overrides it from the
 * environment, so a model that wants a different number is a secret edit
 * rather than a guest-image rebuild — which matters here, since this value
 * is read on the server but spent inside the sandbox.
 */
export const MAX_OUTPUT_TOKENS = 32_000;

/** {@link MAX_OUTPUT_TOKENS}, or a positive `STUDIO_MAX_OUTPUT_TOKENS` override. */
export function studioMaxOutputTokens(env: NodeJS.ProcessEnv = process.env): number {
  // `||` not `??`: an empty-string env var means "unset", as elsewhere here.
  const raw = Number(env.STUDIO_MAX_OUTPUT_TOKENS || Number.NaN);
  return Number.isInteger(raw) && raw > 0 ? raw : MAX_OUTPUT_TOKENS;
}
