// Copyright 2026 the AAI authors. MIT license.
/**
 * Which backend guest sandboxes run on, and why.
 *
 * | Backend           | Guest runs in                     | Isolation | Selected           |
 * | ----------------- | --------------------------------- | --------- | ------------------ |
 * | `modal`           | a remote Modal Sandbox            | full      | always, in prod    |
 * | `subprocess`      | a child process on the host       | **none**  | default, local dev |
 * | `apple-container` | a local Apple container (macOS)   | full      | opt-in only        |
 *
 * ## The policy
 *
 * 1. An explicit `SANDBOX_BACKEND` always wins. An unknown value throws —
 *    silently falling back would look exactly like the override not working.
 * 2. Not local dev → `modal`. This is the production path and it is
 *    unconditional: `isLocalDev` is false whenever `SUPABASE_S3_ENDPOINT` is
 *    set, so a production replica can never resolve a host-local backend, and
 *    fails loudly without Modal credentials rather than quietly running tenant
 *    code on the host.
 * 3. Local dev → `subprocess`.
 *
 * ## Why `subprocess` is the dev default rather than a fallback
 *
 * Both isolating backends have prerequisites a laptop may not have — Modal
 * credentials and a working network for one, Apple's `container` CLI *and* its
 * downloaded guest kernel for the other. Making either the default means the
 * common path for a developer who has neither is a 30-second dial timeout on
 * their first publish, reported as a spawn failure in a backend they did not
 * know they were using. The default is therefore the one backend that always
 * works, and the isolating ones are named explicitly when wanted:
 *
 *     SANDBOX_BACKEND=apple-container   # local containers, needs the CLI
 *     SANDBOX_BACKEND=modal             # remote sandboxes, needs credentials
 *
 * `subprocess` trades away the entire security boundary for that reliability,
 * which is only acceptable because rule 2 makes it unreachable in production.
 * It keeps the *shape* of a real sandbox — separate OS process, real `/ws`
 * JSON-RPC control channel, real `bundle/load`, real `/websocket` sessions —
 * so it still catches the integration bugs a dev backend exists to catch. See
 * `subprocess-sandbox.ts` for what it does and does not reproduce.
 */

import { isLocalDev } from "./_boot.ts";

export type SandboxBackend = "modal" | "apple-container" | "subprocess";

const BACKENDS: readonly SandboxBackend[] = ["modal", "apple-container", "subprocess"];

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
