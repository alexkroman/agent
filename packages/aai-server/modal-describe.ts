// Copyright 2026 the AAI authors. MIT license.
/**
 * Deploy-time bundle inspection on the Modal backend — a ONE-SHOT harness
 * exec in a throwaway sandbox (the guest's describe mode,
 * `AAI_DESCRIBE_BUNDLE_PATH`). Split from modal-sandbox.ts, which owns the
 * long-lived spawn paths; the result parsing is shared with the subprocess
 * backend in describe-exec.ts.
 */

import { CONTAINED_ENV } from "@alexkroman1/aai/runtime";
import { mintDescribeNonce, readDescribeResult } from "./describe-exec.ts";
import { AGENT_BUNDLE_REMOTE_PATH } from "./modal-agent-sandbox.ts";
import { HARNESS_REMOTE_PATH } from "./modal-harness-image.ts";
import { harnessCode, type ModalSpawnContext, modalContext } from "./modal-sandbox.ts";
import { guestSandboxResources } from "./modal-sandbox-env.ts";
import { sandboxTags } from "./sandbox-role.ts";

/** Whole-sandbox lifetime cap for a describe exec (the exec itself is 60s). */
const DESCRIBE_SANDBOX_TIMEOUT_MS = 5 * 60_000;

/**
 * Extract a bundle's self-described config via a ONE-SHOT harness exec in a
 * throwaway Modal sandbox: write the bundle to the sandbox filesystem, exec
 * the harness, parse the last stdout line, terminate. Always the CURRENT
 * harness image — describe runs at deploy time, before any pin exists for
 * the agent. No tunnel, no token, no channel.
 */
export async function describeModalBundle(
  opts: { harnessPath: string; workerCode: string },
  ctx?: ModalSpawnContext,
): Promise<unknown> {
  const [code, context] = await Promise.all([
    harnessCode(opts.harnessPath),
    ctx ? Promise.resolve(ctx) : modalContext(),
  ]);
  const { resourceParams } = guestSandboxResources(process.env);

  const sb = await context.createGuestSandbox(code, {
    command: ["sleep", "infinity"],
    timeoutMs: DESCRIBE_SANDBOX_TIMEOUT_MS,
    ...resourceParams,
    tags: sandboxTags("inspect", "studio-inspect"),
  });
  try {
    const nonce = mintDescribeNonce();
    await sb.filesystem.writeText(opts.workerCode, AGENT_BUNDLE_REMOTE_PATH);
    const proc = await sb.exec(["node", HARNESS_REMOTE_PATH], {
      mode: "binary",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        AAI_DESCRIBE_BUNDLE_PATH: AGENT_BUNDLE_REMOTE_PATH,
        AAI_DESCRIBE_NONCE: nonce,
        [CONTAINED_ENV]: "1",
      },
    });
    return await readDescribeResult(proc, `modal:${sb.sandboxId}`, nonce);
  } finally {
    // Fire-and-forget: nothing on the deploy path depends on the teardown,
    // and DESCRIBE_SANDBOX_TIMEOUT_MS backstops a lost terminate.
    void sb.terminate().catch(() => undefined);
  }
}
