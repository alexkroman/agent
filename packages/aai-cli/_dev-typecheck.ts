// Copyright 2026 the AAI authors. MIT license.
/**
 * The background typecheck under `aai dev`.
 *
 * `assertTypechecks` is wired into `build`, `deploy` and `studio` — and not
 * into `dev`, the loop an author actually lives in. That made the whole
 * compile-message system in `agent-params.ts` (five families of hand-written
 * diagnostic sentences, the most careful work in the SDK) conditional on the
 * author having an editor open on the right file. Demonstrated: a project whose
 * `agent.ts` fails `tsc --noEmit` starts cleanly under `aai dev` and serves,
 * and the typo is found later by `aai build` — or by a caller.
 *
 * Three properties, and each is the reason this is not just a call to
 * `assertTypechecks`:
 *
 * - **It never blocks and never fails the server.** `aai dev` must start with a
 *   type error in an unrelated file; refusing to serve would be a worse tool
 *   than one that says nothing. The report is a `notify`, not a throw.
 * - **It coalesces.** A save touches several files and the watcher debounces to
 *   a restart; without coalescing a burst spawns a `tsc` per restart, and `tsc`
 *   on a real project is seconds. A request during a run schedules exactly one
 *   more, which is `createCoalescingRunner`'s contract.
 * - **It is quiet when clean.** A dev server that prints "types OK" on every
 *   save trains the author to stop reading it, which is how the failure this
 *   exists to surface gets missed again.
 */

import { createCoalescingRunner } from "@alexkroman1/aai/internal";
import { notify } from "./_ui.ts";
import { typecheckProject } from "./typecheck.ts";

/** What {@link createDevTypecheck} hands back: fire-and-forget, already coalesced. */
export type DevTypecheck = {
  /** Schedule a run. Returns immediately; never rejects. */
  request(): void;
};

/**
 * A coalescing background typechecker for the project at `cwd`.
 *
 * `report` is injected so the dev-server specs can read what an author would
 * have seen without capturing stdout — the same seam every other reporter in
 * this package takes.
 */
export function createDevTypecheck(
  cwd: string,
  report: (level: "warn" | "error", message: string) => void = notify,
): DevTypecheck {
  const runner = createCoalescingRunner(async (): Promise<void> => {
    const result = await typecheckProject(cwd);
    if (result.ok) return;
    report(
      "warn",
      `Type errors — \`aai dev\` keeps serving, but \`aai build\` will refuse:\n${result.output}`,
    );
  });
  return {
    request(): void {
      // A typecheck failing is not a reason to take the dev server down, and
      // `typecheckProject` already turns a missing tsconfig or a missing
      // TypeScript into a result rather than a throw — so anything reaching
      // here is a bug in this file, reported and swallowed.
      void runner.trigger().catch((err: unknown) => {
        report("error", `Background typecheck failed to run: ${String(err)}`);
      });
    },
  };
}
