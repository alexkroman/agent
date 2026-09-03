// Copyright 2025 the AAI authors. MIT license.
/**
 * Zod schemas for the host ↔ guest RPC boundary.
 *
 * The isolate (harness-runtime.ts) is self-contained and uses inline type
 * definitions instead of importing these schemas, so host and guest can
 * evolve independently.
 */

import type { RpcConnection } from "./rpc-transport.ts";

// ── Typed method map for the host↔guest RPC link ─────────────────────────────

/**
 * The host's view of the sandbox control channel (see `RpcSchema` in
 * rpc-transport.ts for why method names and outgoing params are typed
 * while results and incoming params stay `unknown`: the guest is untrusted,
 * so everything it sends is validated with Zod at the receiving site —
 * e.g. the studio schemas registered by the session broker).
 *
 * Client voice sessions do NOT ride this link: the guest runs the complete
 * agent runtime and clients connect directly to its public `/websocket`
 * endpoint on the same tunnel.
 *
 * VERSIONING: DEPLOYED AGENTS do not use this link at all — their whole
 * contract is the exec-env boot convention plus the token-gated `/manage/*`
 * HTTP surface (see aai-guest/harness-agent-mode.ts and
 * `agentServerFromGuest`), pinned per deploy via the harness image and
 * versioned by GUEST_CONTRACT_VERSION. That HTTP surface must stay BACKWARD
 * compatible (additive changes only): the host may be newer than a pinned
 * agent's harness. THIS map is the studio side — those sandboxes
 * always spawn from the current image, so it changes atomically with the
 * server.
 */
/**
 * Params of the host→guest `studio/session-init` request — installs the
 * studio coding-agent session in the guest: workspace files, the CALLER'S
 * OWN AssemblyAI key (the guest's LLM credential — never a platform key),
 * the broker-minted per-session chat bearer, the system prompt, and turn
 * config. The browser then talks to the guest's `POST /studio/chat`
 * directly, mirroring how voice sessions connect to a deployed agent,
 * presenting `chatToken` — never a long-lived credential.
 */
export type StudioSessionInitParams = {
  project: string;
  files: Record<string, string>;
  apiKey: string;
  /** Per-session bearer for the guest's public chat surface. */
  chatToken: string;
  system: string;
  model: string;
  region?: "eu";
  maxSteps: number;
};

/**
 * Params of the host→guest `workspace/deploy` request — Publish: the guest
 * materializes the files under its toolchain root and runs the literal
 * `aai deploy` CLI against `serverUrl` on the CALLER'S OWN key (see
 * aai-guest/studio-publish.ts). Build, config extraction, ownership, and
 * the credential preflight all run exactly as for a laptop deploy; the
 * CLI's output rides back for the chat.
 */
export type WorkspaceDeployParams = {
  files: Record<string, string>;
  /** Public platform origin the guest's CLI deploys to. */
  serverUrl: string;
  /** The caller's own API key — never a platform credential. */
  apiKey: string;
  /** Existing slug to redeploy; omit and the deploy claims/generates one. */
  slug?: string;
  /**
   * Opt into a `-preview`-suffixed slug, which the deploy boundary otherwise
   * rejects. Sent ONLY by the studio's auto-preview deployer; Publish shares
   * this request and leaves it unset, so a project named `*-preview` can't
   * claim a slug the orphan-preview reaper deletes hourly.
   */
  allowPreviewSlug?: boolean;
  /**
   * `--skipTypecheck`: forwarded to the in-sandbox `aai deploy` so a Publish
   * can skip its tsc gate the way `aai deploy --skipTypecheck` does. Absent
   * (the default) runs the gate; `| undefined` so the sender can pass a plain
   * `boolean | undefined` through rather than a guarded spread.
   */
  skipTypecheck?: boolean | undefined;
};

export type GuestRpcSchema = {
  requestsOut: {
    "studio/session-init": { params: StudioSessionInitParams; result: unknown };
    "workspace/deploy": { params: WorkspaceDeployParams; result: unknown };
  };
  requestsIn: {
    /** End-of-turn workspace write-back into the project store. */
    "studio/sync-workspace": { params: unknown; result: unknown };
    /** End-of-turn conversation snapshot into the project's chat row. */
    "studio/persist-chat": { params: unknown; result: unknown };
    /**
     * The coding agent's `read_logs`: what the project's own deployed agent
     * printed. The guest names an ENVIRONMENT, never a slug — the host resolves
     * that against the (scope, project) this sandbox is pinned to
     * (aai-studio-server/studio-agent-logs.ts).
     */
    "studio/agent-logs": { params: unknown; result: unknown };
  };
  notificationsOut: {
    shutdown: undefined;
  };
  notificationsIn: Record<string, never>;
};

/** An RPC connection to a guest sandbox, typed with the guest method map. */
export type GuestConnection = RpcConnection<GuestRpcSchema>;
