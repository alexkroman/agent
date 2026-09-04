// Copyright 2026 the AAI authors. MIT license.

import { CliError } from "./_output.ts";
import { log } from "./_ui.ts";
import { typecheckProject } from "./typecheck.ts";

/**
 * The build/deploy typecheck gate: run the project's own `tsc --noEmit`
 * (see `typecheck.ts`) and turn a failure into a structured CliError. The
 * bundlers strip types unchecked, so without this a type-broken agent
 * ships and misbehaves at runtime instead of failing here.
 */
export async function assertTypechecks(
  cwd: string,
  opts: { skip?: boolean | undefined } = {},
): Promise<void> {
  // The gate reads the flag its own remedy names. It used to be
  // `if (!opts.skipTypecheck) await assertTypechecks(cwd)` at each of three call
  // sites — a bypass condition spelled per caller is one a fourth caller can add
  // without, which is the representable-mistake class `defineExec`'s `cwd` field
  // exists to close.
  if (opts.skip) return;
  log.step("Type checking…");
  const result = await typecheckProject(cwd);
  if (!result.ok) {
    throw new CliError(
      "typecheck_failed",
      result.output,
      "Fix the type errors, or pass --skipTypecheck to build anyway",
    );
  }
}
