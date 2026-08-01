// Copyright 2026 the AAI authors. MIT license.
/**
 * Which backend guest sandboxes run on, and why.
 *
 * | Backend           | Guest runs in                   | Isolation | Selected           |
 * | ----------------- | ------------------------------- | --------- | ------------------ |
 * | `modal`           | a remote Modal Sandbox          | full      | always, in prod    |
 * | `apple-container` | a local Apple container (macOS) | full      | default, local dev |
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
 * 3. Local dev → `apple-container`.
 *
 * ## Why there is no isolation-free backend
 *
 * A `subprocess` backend (the harness as a plain child process of the server)
 * used to be the local-dev default, chosen because it always worked. It also
 * had **no isolation at all** — tenant code ran with the server's uid,
 * filesystem, and network — and anything relying on being *contained* behaved
 * differently once deployed. Every guest now runs behind a real container
 * boundary, at the cost of a hard local prerequisite: Apple's `container` CLI
 * (or `SANDBOX_BACKEND=modal` with credentials). Boot names the selected
 * backend and checks its prerequisite up front (`assertSandboxBackendOrWarn`),
 * so a missing CLI surfaces as a boot-time message rather than a 30-second
 * dial timeout on the first publish.
 *
 *     SANDBOX_BACKEND=apple-container   # local containers, needs the CLI
 *     SANDBOX_BACKEND=modal             # remote sandboxes, needs credentials
 */

import { isLocalDev } from "./_boot.ts";

export type SandboxBackend = "modal" | "apple-container";

const BACKENDS: readonly SandboxBackend[] = ["modal", "apple-container"];

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
    ? { backend: "apple-container", reason: "local dev default" }
    : { backend: "modal", reason: "not local dev" };
}

/** Which backend guest sandboxes run on. See {@link describeSandboxBackend}. */
export function resolveSandboxBackend(env: NodeJS.ProcessEnv): SandboxBackend {
  return describeSandboxBackend(env).backend;
}
