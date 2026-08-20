// Copyright 2026 the AAI authors. MIT license.
/**
 * What a service ANNOUNCES and GUARDS at boot, split from the bindings it
 * builds.
 *
 * `service-config.ts` answers "what does this environment give us"; these three
 * answer "what should an operator be told, and what must not take the process
 * down". They ran together only because both are called from the entry, and
 * keeping them together is what put that file at its length cap.
 *
 * All three are re-exported from `service-config.ts`, which is the subpath the
 * entry imports — the split is internal.
 *
 * @module
 */

import { errorMessage } from "@alexkroman1/aai";
import { isLocalDev } from "./_boot.ts";
import { resolveHarnessPath } from "./constants.ts";
import { endLiveStreams } from "./live-streams.ts";
import { createLogger } from "./logger.ts";
import { isModalConfigured, modalRequiredError, prewarmModal } from "./modal-context.ts";
import { describeSandboxBackend } from "./sandbox-backend.ts";

const log = createLogger("service");
const sandboxLog = createLogger("sandbox");

/**
 * Boot-time sandbox-backend check, so a misconfiguration fails (or warns)
 * where the cause is obvious instead of on the first session's spawn.
 *
 * The selected backend is logged unconditionally. Previously this only spoke
 * up for missing Modal credentials, so the most confusing configuration of
 * all — auto-selection quietly landing on a backend the developer did not
 * choose — was the one that produced no output at all, and surfaced instead
 * as a spawn failure naming an unexpected backend. That log line also carries
 * the isolation warning: `subprocess` runs tenant code (and the studio coding
 * agent's `bash`/`run_code`) with this process's uid.
 *
 * `subprocess` has no prerequisite to check — that is the point of it being
 * the local-dev default. `modal` needs credentials: fatal in production, a
 * warning in local dev so non-sandbox surfaces stay usable.
 */
export function assertSandboxBackendOrWarn(env: NodeJS.ProcessEnv): void {
  const { backend, reason } = describeSandboxBackend(env);
  sandboxLog.info(`backend=${backend} (${reason})`);

  if (backend === "subprocess") {
    sandboxLog.warn(
      "WARNING: guests run as child processes with NO isolation — " +
        "agent code and the studio agent's shell tools share this process's uid, " +
        "filesystem, and network. Set SANDBOX_BACKEND=modal for real sandboxes.",
    );
    return;
  }

  if (!isModalConfigured()) {
    if (isLocalDev(env)) {
      sandboxLog.warn(
        "WARNING: Modal credentials not configured " +
          "(MODAL_TOKEN_ID/MODAL_TOKEN_SECRET). Sandbox creation will fail.",
      );
    } else {
      throw modalRequiredError();
    }
  } else {
    // Resolve the Modal context AND bake/publish the guest snapshot image now
    // (fire-and-forget), so neither the gRPC round trip nor — far more
    // expensive, and unavoidable on the first boot of every new harness
    // version — the image build lands on the first session's cold start.
    // The harness path is resolved separately: it throws when the harness
    // isn't built, which must not take down boot for a prewarm.
    prewarmModal(harnessPathOrWarn());
  }
}

/** The built harness, or undefined with a warning — a prewarm may not fail boot. */
function harnessPathOrWarn(): string | undefined {
  try {
    return resolveHarnessPath();
  } catch (err) {
    sandboxLog.warn("guest image prewarm skipped", { error: errorMessage(err) });
  }
}

/** Process-level safety nets, registered before anything else at boot. */
export function installProcessSafetyNets(): void {
  process.on("unhandledRejection", (err) => {
    log.error("unhandled rejection", { error: err });
  });
  process.on("uncaughtException", (err) => {
    log.error("uncaught exception", { error: err });
    // The other way this process dies with responses open. `process.exit`
    // destroys sockets mid-body, so every live SSE stream would be cut before
    // its terminating chunk — the `TransferEncodingError` of live-streams.ts,
    // with a crash rather than a scale-in behind it. Ending them is synchronous
    // and cannot make the crash worse.
    endLiveStreams();
    process.exit(1);
  });
}
