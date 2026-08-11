// Copyright 2026 the AAI authors. MIT license.
/**
 * Provider warnings — the AI SDK's report that a setting it was handed did not
 * survive the request.
 *
 * **These went nowhere.** A provider that cannot honour something returns a
 * warning rather than failing (`unsupported-setting`, `unsupported-tool`,
 * `other`), the SDK's default is to print it once per process, and nothing
 * here ever looked at them — so a setting silently dropped by the provider was
 * invisible on the exact axis this repo keeps getting bitten on. Both of the
 * long-form cases in the guides are that shape: `sttPrompt` reaching an S2S
 * agent that never forwarded it, and `reasoning_effort` on a model family that
 * refuses tools alongside it. A dropped setting reads to an author as "this
 * option does nothing", which draws no bug report at all.
 *
 * `AI_SDK_LOG_WARNINGS` is a process-global hook, so this is installed ONCE
 * per process rather than per runtime — and installed idempotently, because
 * `aai dev` rebuilds its runtime on every file save and a second install would
 * be a second line per warning.
 *
 * **Warn, never throw.** A warning means the call is proceeding; turning one
 * into a failure would take a live session down over a setting the provider
 * merely ignored.
 */

import type { Warning } from "ai";
import type { Logger } from "./runtime-config.ts";

/** One entry of the SDK's warning union. */
type ProviderWarning = Warning;

/** True once the global hook is ours, so repeated runtimes install one. */
let installed = false;

/**
 * Route the AI SDK's provider warnings into `logger.warn`.
 *
 * The global is typed by the SDK as `LogWarningsFunction | undefined | false`
 * on `globalThis`; `false` disables the SDK's own printing entirely, which is
 * not what we want — we want the same information somewhere a server log
 * aggregates.
 *
 * @param logger where warnings go
 * @param reset test-only: allow a re-install (the flag is process-global)
 */
export function installProviderWarningLogger(logger: Logger, reset = false): void {
  if (reset) installed = false;
  if (installed) return;
  installed = true;
  globalThis.AI_SDK_LOG_WARNINGS = ({ warnings, provider, model }) => {
    const origin = {
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
    };
    for (const warning of warnings) {
      logger.warn("Provider warning", { ...origin, ...warningFields(warning) });
    }
  };
}

/**
 * The warning's own fields, flattened.
 *
 * The union's arms name the dropped thing differently — `feature` on
 * `unsupported`/`compatibility`, `setting` on `deprecated` — and that name IS
 * the content of the warning, so every arm's is forwarded rather than
 * narrowing to one and logging a type with no subject.
 */
function warningFields(warning: ProviderWarning): Record<string, unknown> {
  return {
    type: warning.type,
    ...("feature" in warning ? { feature: warning.feature } : {}),
    ...("setting" in warning ? { setting: warning.setting } : {}),
    ...("details" in warning && warning.details !== undefined ? { details: warning.details } : {}),
    ...("message" in warning ? { message: warning.message } : {}),
  };
}
