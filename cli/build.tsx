// Copyright 2025 the AAI authors. MIT license.

import { buildAgentBundle } from "./_build.tsx";
import { runWithInk, Step } from "./_ink.tsx";

export async function runBuildCommand(opts: { cwd: string }): Promise<void> {
  await runWithInk(async ({ log }) => {
    await buildAgentBundle(opts.cwd, log);
    log(<Step action="Build" msg="ok" />);
  });
}
