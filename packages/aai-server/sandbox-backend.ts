// Copyright 2026 the AAI authors. MIT license.
/**
 * Which backend guest sandboxes run on, and why.
 *
 * | Backend      | Guest runs in               | Isolation | Selected            |
 * | ------------ | --------------------------- | --------- | ------------------- |
 * | `modal`      | a remote Modal Sandbox      | full      | the DEFAULT         |
 * | `subprocess` | a child process on the host | **none**  | `AAI_LOCAL_DEV=1`   |
 *
 * ## The policy
 *
 * 1. An explicit `SANDBOX_BACKEND` always wins. An unknown value throws —
 *    silently falling back would look exactly like the override not working.
 * 2. Not local dev → `modal`. This is the production path and it is the DEFAULT:
 *    `isLocalDev` is an explicit `AAI_LOCAL_DEV=1` and nothing else, so a
 *    deployment that sets no variable at all still gets real sandboxes, and one
 *    without Modal credentials fails loudly rather than quietly running tenant
 *    code on the host.
 * 3. `AAI_LOCAL_DEV=1` → `subprocess`.
 *
 * That sentinel used to be `!SUPABASE_STORAGE_BUCKET`, which inverts rule 2's
 * whole point — it made the isolation-free branch the one a FORGOTTEN variable
 * lands on. It also tied the backend to where platform state lives, so running
 * a dev server against the local Supabase stack silently demanded Modal
 * credentials; `scripts/dev-server.mjs` sets the declaration instead.
 *
 * ## Two tiers, deliberately — no middle one
 *
 * A local-container backend (Apple's `container` CLI) sat between these for a
 * while and was removed, because a dev backend that is *nearly* production
 * buys nothing that either neighbour does not do better:
 *
 * - It could not give production confidence — only `SANDBOX_BACKEND=modal`
 *   can, since that IS production.
 * - It cost a whole extra delivery mechanism for the in-guest build toolchain
 *   (Modal bakes one into its snapshot image; a local container had to have an
 *   equivalent built and mounted for it), and it invented failure modes that
 *   exist in no other environment — a linux guest cannot load the host's
 *   darwin-installed native binaries, and a loopback platform origin resolves
 *   to the guest's own harness rather than the dev server.
 *
 * So the two tiers are: `subprocess` for fast iteration, and `modal` when the
 * question is "does this really work". `subprocess` keeps the *shape* of a
 * sandbox — a separate OS process, the real `/ws` JSON-RPC control channel,
 * real agent-mode file boots, real `/websocket` sessions, real dial-retry and
 * orphan-timeout behavior — so it still catches the integration bugs a dev
 * backend exists to catch. See `subprocess-sandbox.ts` for what it does and
 * does not reproduce.
 *
 * It trades away the entire security boundary to do that, which is only
 * acceptable because rule 2 makes it unreachable unless someone declares it.
 * Note this includes the studio coding agent's `bash` and `run_code` tools:
 * under `subprocess` those run on the dev machine with the server's uid.
 *
 *     SANDBOX_BACKEND=modal   # remote sandboxes, needs credentials
 */

import { isLocalDev } from "./_boot.ts";

export type SandboxBackend = "modal" | "subprocess";

const BACKENDS: readonly SandboxBackend[] = ["modal", "subprocess"];

/** The selected backend plus the human-readable reason, for the boot log. */
export type BackendChoice = {
  backend: SandboxBackend;
  reason: string;
};

/**
 * Resolve the backend and explain the choice. Every branch produces a reason:
 * "which sandbox backend am I on, and why" must be answerable from one boot
 * log line rather than inferred from the shape of a later failure.
 */
export function describeSandboxBackend(env: NodeJS.ProcessEnv): BackendChoice {
  const raw = env.SANDBOX_BACKEND?.trim().toLowerCase();
  if (raw) {
    const override = BACKENDS.find((b) => b === raw);
    if (!override) {
      throw new Error(
        `Unknown SANDBOX_BACKEND ${JSON.stringify(raw)} — expected ` +
          BACKENDS.map((b) => `"${b}"`).join(", "),
      );
    }
    return { backend: override, reason: "SANDBOX_BACKEND override" };
  }
  return isLocalDev(env)
    ? { backend: "subprocess", reason: "local dev default" }
    : { backend: "modal", reason: "not local dev" };
}

/** Which backend guest sandboxes run on. See {@link describeSandboxBackend}. */
export function resolveSandboxBackend(env: NodeJS.ProcessEnv): SandboxBackend {
  return describeSandboxBackend(env).backend;
}
