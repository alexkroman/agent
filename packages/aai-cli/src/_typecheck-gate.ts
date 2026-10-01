// Copyright 2026 the AAI authors. MIT license.

import { CliError } from "./_output.ts";
import { defaultUi, type Ui } from "./_ui.ts";
import { typecheckProject } from "./typecheck.ts";

/**
 * The build/deploy typecheck gate: run the project's own `tsc --noEmit`
 * (see `typecheck.ts`) and turn a failure into a structured CliError. The
 * bundlers strip types unchecked, so without this a type-broken agent
 * ships and misbehaves at runtime instead of failing here.
 */
export async function assertTypechecks(
  cwd: string,
  opts: { skip?: boolean | undefined; ui?: Ui | undefined } = {},
): Promise<void> {
  // The gate reads the flag its own remedy names, so no caller spells the
  // bypass condition itself.
  if (opts.skip) return;
  (opts.ui ?? defaultUi).log.step("Type checking…");
  const result = await typecheckProject(cwd);
  if (!result.ok) {
    throw new CliError(
      "typecheck_failed",
      result.output,
      "Fix the type errors, or pass --skip-typecheck to build anyway",
    );
  }
}
