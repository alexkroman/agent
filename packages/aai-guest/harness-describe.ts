// Copyright 2026 the AAI authors. MIT license.
/**
 * The guest's ONE-SHOT describe mode: import a bundle and report the config
 * it self-describes. Split from harness.ts, which owns the long-lived server
 * modes; this is the whole of the deploy-time inspection contract.
 */

import { readFile } from "node:fs/promises";
import { emptyHarnessState, loadBundle } from "./harness-bundle.ts";
import { errMsg } from "./harness-rpc.ts";

/**
 * Read the exec's describe marker and REMOVE it from `process.env`.
 *
 * Must run before any bundle code: the bundle is imported into this process,
 * so anything still in `process.env` is readable by it — and a nonce the
 * bundle can read is a nonce it can forge.
 */
export function takeDescribeNonce(): string | undefined {
  const nonce = process.env.AAI_DESCRIBE_NONCE;
  delete process.env.AAI_DESCRIBE_NONCE;
  return nonce;
}

/**
 * DESCRIBE MODE — deploy-time bundle inspection as a ONE-SHOT exec: import
 * the bundle named by `AAI_DESCRIBE_BUNDLE_PATH` (in the sandbox, never on
 * the host) and print the config it self-describes (`__aaiConfig`) as a
 * single JSON line on stdout — `{ ok, config | error, nonce }`. The exit
 * code mirrors `ok`. No token, no server, no channel: the process is the
 * whole contract, and the spawner tears the sandbox down when it exits.
 *
 * **The nonce is what makes the answer the HARNESS's** (`AAI_DESCRIBE_NONCE`,
 * minted per exec by the spawner, which accepts only the last line carrying
 * it). "The host parses the last stdout line" is not a defense on its own:
 * the bundle runs in THIS process, so a `process.on("exit")` handler prints
 * after us and its line is last. Measured — a bundle doing exactly that had
 * its own `{ok:true,config}` accepted in place of the real one, which is how
 * a deploy can declare a config the SDK never produced (an empty
 * `requiredEnv` skips the credential preflight). `main` deletes the nonce
 * from `process.env` BEFORE the bundle is imported, so bundle code cannot
 * read it; without that the nonce would just be one more thing to forge.
 */
export async function mainDescribe(bundlePath: string, nonce: string | undefined): Promise<void> {
  const state = emptyHarnessState();
  const emit = (payload: Record<string, unknown>): void => {
    process.stdout.write(`\n${JSON.stringify({ ...payload, ...(nonce ? { nonce } : {}) })}\n`);
  };
  try {
    const code = await readFile(bundlePath, "utf-8");
    const loaded = await loadBundle(state, { code, env: {} });
    emit({ ok: true, config: loaded.config });
    process.exit(0);
  } catch (err) {
    emit({ ok: false, error: errMsg(err) });
    process.exit(1);
  }
}
