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

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { errorMessage } from "@alexkroman1/aai";
import { isRecord } from "@alexkroman1/aai/utils";
import { isLocalDev } from "./_boot.ts";
import { resolveHarnessPath } from "./constants.ts";
import { guestImageRegistry } from "./guest-image-source.ts";
import { endLiveStreams } from "./live-streams.ts";
import { createLogger } from "./logger.ts";
// Statically: this module is already in the graph via sandbox-vm.ts, so a
// dynamic import of it splits no chunk and rolldown says so
// (INEFFECTIVE_DYNAMIC_IMPORT). Only the SDK import below needs to be lazy —
// that one is a native addon the bundled entry must never require at load.
import { LOCAL_GUEST_IMAGE_TAG } from "./microsandbox-sandbox.ts";
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

  if (backend === "microsandbox") {
    void warnOnMissingGuestImage();
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

/**
 * Warn at BOOT when the microVM backend has no image to boot from.
 *
 * Without this the first session pays a 30-second dial timeout against a
 * sandbox that never started, and the error reads as a guest that failed to
 * boot rather than an image that was never built — the failure is one command
 * away from fixed and nothing says which command.
 *
 * A WARNING rather than a throw, matching the Modal-credentials branch beside
 * it: this backend is local-dev only, and refusing to boot the server over a
 * missing dev artifact is worse than telling the developer what to run. The
 * check is fire-and-forget for the same reason the Modal prewarm is — a
 * diagnostic may not fail boot, and a registry-configured dev server has no
 * local image to find in the first place.
 */
async function warnOnMissingGuestImage(): Promise<void> {
  try {
    if (guestImageRegistry(process.env) !== undefined) return;
    const { Image } = await import("microsandbox");
    await Image.get(LOCAL_GUEST_IMAGE_TAG);
  } catch (err) {
    sandboxLog.warn(
      "WARNING: no local guest image for the microsandbox backend — " +
        "run `pnpm build:guest-image --msb` to build and load one, " +
        "or set SANDBOX_BACKEND=subprocess to run guests without isolation.",
      { error: errorMessage(err) },
    );
    return;
  }
  warnOnStaleGuestImage();
}

/** The stamp `scripts/build-guest-image.mjs` writes beside the harness. */
const GUEST_IMAGE_STAMP = ".guest-image-stamp.json";

/**
 * Warn when the local guest image was built from a DIFFERENT harness than the
 * one on disk.
 *
 * The check above can only ever see the image MISSING, because
 * `aai-guest-harness:local` is a mutable tag — so an image and the harness
 * beside it drift with nothing saying so, and every guest silently runs whatever
 * code was current when the image was last built. That cost an hour of manual
 * testing against a two-day-old image: the guest printed a diagnostic that had
 * been reworded since, reported an SDK version one release back, and behaved
 * like the branch under test had never landed. Nothing about the failure named
 * the image.
 *
 * It compares the harness's own digest against the stamp the build wrote, so it
 * is exact rather than an mtime heuristic — `ensure-guest-harness.mjs` records
 * what mtime costs under a turbo cache hit. An ABSENT stamp is reported the same
 * way, because an image built before this existed is exactly the case worth
 * warning about; a rebuild writes one.
 *
 * A warning, never a throw, matching every other check here: this backend is
 * local-dev only, and the remedy is one command.
 */
function warnOnStaleGuestImage(): void {
  const remedy =
    "rebuild it with `pnpm build:guest-image --msb`, or set " +
    "SANDBOX_BACKEND=subprocess to run the harness on disk directly.";
  try {
    const harnessPath = resolveHarnessPath();
    const stampPath = join(dirname(harnessPath), GUEST_IMAGE_STAMP);
    if (!existsSync(stampPath)) {
      sandboxLog.warn(`WARNING: the local guest image records no harness — ${remedy}`, {
        stamp: stampPath,
      });
      return;
    }
    const stamp: unknown = JSON.parse(readFileSync(stampPath, "utf-8"));
    const built = isRecord(stamp) ? stamp.harnessSha256 : undefined;
    const current = createHash("sha256").update(readFileSync(harnessPath)).digest("hex");
    if (built === current) return;
    sandboxLog.warn(
      "WARNING: the local guest image is STALE — it was built from a different " +
        `harness than ${harnessPath}, so every guest will run that older code. ${remedy}`,
      { built, current },
    );
  } catch (err) {
    // A diagnostic may not fail a boot, and it may not be silent either: an
    // unreadable harness or a corrupt stamp is itself worth one line.
    sandboxLog.warn("guest image staleness check skipped", { error: errorMessage(err) });
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
