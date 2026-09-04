// Copyright 2026 the AAI authors. MIT license.
/**
 * Gating a suite on a real microVM.
 *
 * Same shape, and the same argument, as `describeWithPg` in `_pg-test-utils.ts`:
 * this tier is the only thing that can see a bug in the parts no fake reaches —
 * whether the published port actually forwards, whether the composed network
 * policy lets the guest resolve DNS, whether the harness in the image really
 * boots. An injected context cannot be wrong about any of those, so a SILENT
 * skip is the worst outcome available.
 *
 * It needs two things a machine may not have:
 *
 * Both are probed by ASKING THE RUNTIME A REAL QUESTION rather than by
 * `isInstalled()`, which is measured to lie: on a machine that boots microVMs
 * fine (`Image.get` resolves, `Image.list` returns five images) it still
 * answered `false`. A gate built on it skips the tier silently on exactly the
 * machines where it would have worked, which is the failure this whole file is
 * written to avoid.
 *
 * - **Hardware virtualization.** libkrun needs Hypervisor.framework (Apple
 *   Silicon) or KVM (Linux). GitHub's standard hosted runners do not reliably
 *   provide either — `/dev/kvm` is inconsistently present on `ubuntu-latest`
 *   and absent inside the macOS runner VM — so this tier is a LOCAL tier until
 *   it runs on a larger runner or a self-hosted Linux box with KVM.
 * - **A guest image.** Either the local build (`pnpm build:guest-image --msb`)
 *   or a configured `GUEST_IMAGE_REGISTRY` to pull from.
 *
 * `AAI_REQUIRE_MICROSANDBOX=1` turns a skip into a hard failure, so a runner
 * that is supposed to provide those and stops doing so is red rather than
 * quiet. It must be declared in the `check:scenario` task's `env` in
 * `turbo.json` — strict env mode strips an undeclared variable before the task
 * starts, which would make the enforcement silently inert.
 */

import { guestImageRegistry } from "./guest-image-source.ts";
import { LOCAL_GUEST_IMAGE_TAG } from "./microsandbox-sandbox.ts";

export type MicrosandboxAvailability = { available: true } | { available: false; reason: string };

/**
 * Whether a real microVM can be booted here.
 *
 * Deliberately async and meant for a module's TOP LEVEL, not a gated `describe`
 * body: vitest EXECUTES a `describe.skip` callback to enumerate what it is
 * skipping, so a probe in there runs on the machine that cannot satisfy it and
 * fails the file instead of skipping it.
 */
export async function probeMicrosandbox(): Promise<MicrosandboxAvailability> {
  let sdk: typeof import("microsandbox");
  try {
    sdk = await import("microsandbox");
  } catch (err) {
    return { available: false, reason: `the microsandbox SDK did not load (${String(err)})` };
  }
  // A registry-configured run pulls its image, so there is nothing local to
  // find — `Image.list` is then the probe, because it still needs a working
  // runtime to answer at all.
  const registry = guestImageRegistry(process.env) !== undefined;
  try {
    if (registry) await sdk.Image.list();
    else await sdk.Image.get(LOCAL_GUEST_IMAGE_TAG);
    return { available: true };
  } catch (err) {
    return {
      available: false,
      reason: registry
        ? `the microsandbox runtime did not answer (${String(err).slice(0, 120)})`
        : `no ${LOCAL_GUEST_IMAGE_TAG} image, or no working runtime — run ` +
          "`pnpm build:guest-image --msb`",
    };
  }
}

/**
 * A skip that says why, or a failure when the run DECLARED it needs a microVM.
 *
 * Returns the `describe` to use, so a suite reads
 * `const d = describeMicrosandbox(probe)` and gates nothing by hand.
 */
export function microsandboxGate(
  availability: MicrosandboxAvailability,
  env: NodeJS.ProcessEnv = process.env,
): { skip: boolean; reason?: string } {
  if (availability.available) return { skip: false };
  if (env.AAI_REQUIRE_MICROSANDBOX === "1") {
    throw new Error(
      `AAI_REQUIRE_MICROSANDBOX=1 but a microVM is unavailable: ${availability.reason}`,
    );
  }
  return { skip: true, reason: availability.reason };
}
