// Copyright 2026 the AAI authors. MIT license.
/**
 * Which backend guest sandboxes run on, and why.
 *
 * | Backend        | Guest runs in                  | Isolation | Selected          |
 * | -------------- | ------------------------------ | --------- | ----------------- |
 * | `modal`        | a remote Modal Sandbox         | full      | the DEFAULT       |
 * | `microsandbox` | a local microVM (libkrun)      | full      | `AAI_LOCAL_DEV=1` |
 * | `subprocess`   | a child process on the host    | **none**  | opt-in only       |
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
 * 3. `AAI_LOCAL_DEV=1` → `microsandbox`.
 *
 * That sentinel used to be `!SUPABASE_STORAGE_BUCKET`, which inverts rule 2's
 * whole point — it made the isolation-free branch the one a FORGOTTEN variable
 * lands on. It also tied the backend to where platform state lives, so running
 * a dev server against the local Supabase stack silently demanded Modal
 * credentials; `scripts/dev-server.mjs` sets the declaration instead.
 *
 * `subprocess` is reachable ONLY by naming it. That is a demotion: it used to be
 * what local dev got by default, and defaulting to the backend with no boundary
 * meant the studio coding agent's `bash` and `run_code` ran on the developer's
 * machine as the server's uid unless somebody had opted out. A backend that
 * trades away the whole security model should be a decision, not a default.
 *
 * ## There IS a middle tier now, and what it had to earn
 *
 * This section used to be titled "Two tiers, deliberately — no middle one". A
 * local-container backend (Apple's `container` CLI) sat between these for a
 * while and was removed on three objections. `microsandbox` is held to the same
 * three, and answers them differently:
 *
 * - **"It cannot give production confidence."** Still true, and still the
 *   reason `modal` exists: only that backend IS production. What this one is
 *   for is a boundary on the developer's own machine, and a guest environment
 *   that matches — not confidence.
 * - **"It costs a whole extra toolchain delivery mechanism."** This is the one
 *   that inverted. There is now ONE image recipe
 *   (`guest-image.Dockerfile`), pulled by reference, so the local backend boots
 *   the same image production does instead of needing an equivalent built and
 *   mounted for it. Guests BUILD workspaces, and `subprocess` resolves that
 *   toolchain from aai-guest's darwin/pnpm `node_modules` while production
 *   resolves an `npm ci` tree on `node:26-slim` — a divergence no local test
 *   could see. Same architecture is NOT claimed: Modal is amd64 and an Apple
 *   Silicon host is arm64, so it is one recipe on two architectures.
 * - **"It invents failure modes that exist nowhere else."** Half of this was
 *   real and is designed around. The darwin-native-binaries problem is gone
 *   because nothing mounts host `node_modules` — the guest uses the image's own
 *   `/opt/aai`. The loopback problem is real and is the whole subject of
 *   `microsandbox-network.ts`: a VM's `127.0.0.1` is the VM, so the guest env is
 *   rewritten to a host alias and the network policy opens exactly the ports
 *   that rewrite created a need for.
 *
 * `subprocess` stays, because it is still the fastest way to iterate and it
 * keeps the *shape* of a sandbox — a separate OS process, the real `/ws`
 * JSON-RPC control channel, real agent-mode file boots, real `/websocket`
 * sessions, real dial-retry and orphan-timeout behavior. See
 * `subprocess-sandbox.ts` for what it does and does not reproduce. It trades
 * away the entire security boundary to do that, which is why it is now opt-in:
 * under it, the studio coding agent's `bash` and `run_code` run on the dev
 * machine with the server's uid.
 *
 *     SANDBOX_BACKEND=modal        # remote sandboxes, needs credentials
 *     SANDBOX_BACKEND=subprocess   # no isolation; fastest iteration
 */

import { isLocalDev } from "./_boot.ts";

export type SandboxBackend = "modal" | "microsandbox" | "subprocess";

const BACKENDS: readonly SandboxBackend[] = ["modal", "microsandbox", "subprocess"];

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
    ? { backend: "microsandbox", reason: "local dev default" }
    : { backend: "modal", reason: "not local dev" };
}

/** Which backend guest sandboxes run on. See {@link describeSandboxBackend}. */
export function resolveSandboxBackend(env: NodeJS.ProcessEnv): SandboxBackend {
  return describeSandboxBackend(env).backend;
}
