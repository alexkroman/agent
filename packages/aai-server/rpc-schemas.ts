// Copyright 2025 the AAI authors. MIT license.
/**
 * Zod schemas for the host ↔ guest RPC boundary.
 *
 * The isolate (harness-runtime.ts) is self-contained and uses inline type
 * definitions instead of importing these schemas, so host and guest can
 * evolve independently.
 */

import { DEFAULT_SYSTEM_PROMPT, errorMessage } from "@alexkroman1/aai";
import {
  AgentConfigSchema,
  assertPipelineTuning,
  assertProviderTriple,
  assertSilencePolicy,
  ToolSchemaSchema,
} from "@alexkroman1/aai/manifest";
import { z } from "zod";
import type { RpcConnection } from "./rpc-transport.ts";

/**
 * The host↔guest wire format for an agent's config — the canonical
 * `AgentConfigSchema` (sdk/_internal-types.ts) plus the wire-only
 * `toolSchemas`, with a handful of explicit overrides. Deriving via
 * `.extend` (rather than re-declaring the field list) is what makes a new
 * `AgentConfig` field flow through the server by default: the old
 * hand-copied schema was one of the three shapes where an omission was
 * valid TypeScript and a silently dropped field.
 *
 * Every override below either loosens a rule (a *stored* bundle from an
 * older CLI must keep loading — see sandbox-compat.test.ts) or supplies a
 * wire default; none may drop a field.
 */
export const IsolateConfigSchema = AgentConfigSchema.extend({
  // Wire tolerance: older stored configs predate author-time strictness.
  name: z.string(),
  maxSteps: z.number().optional(),
  // Plain strings, not the BuiltinTool enum: a stored bundle may name a
  // builtin this build no longer knows, and that must not stop the agent
  // from loading (unknown names are ignored at resolution).
  builtinTools: z.array(z.string()).optional(),
  // The base schema now defaults these too; the wire keeps its own spellings
  // so platform behavior stays put: a stored config without a greeting speaks
  // none, never the SDK default phrase.
  systemPrompt: z.string().default(DEFAULT_SYSTEM_PROMPT),
  greeting: z.string().optional(),
  // Wire-only: the agent's custom tool schemas ride alongside the config.
  toolSchemas: z.array(ToolSchemaSchema).default([]),
}).superRefine((cfg, ctx) => {
  function fail(message: string): void {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  }
  try {
    const mode = assertProviderTriple(cfg.stt, cfg.llm, cfg.tts, cfg.s2s);
    if (cfg.mode === "pipeline" && mode !== "pipeline") {
      fail("mode='pipeline' requires stt, llm, and tts to be set");
    }
    assertSilencePolicy(mode, cfg.silenceTimeoutMs, cfg.silencePrompt);
    assertPipelineTuning(mode, cfg);
  } catch (err) {
    fail(errorMessage(err));
  }
});

export type IsolateConfig = z.infer<typeof IsolateConfigSchema>;

/** Response of the guest `status` request (guest-asserted wire data). */
export const StatusResponseSchema = z.object({
  activeSessions: z.number().int().nonnegative(),
});

/**
 * Response of one one-shot guest tool trial (the studio's test_agent).
 * Exactly one of `result`/`error` is set; `state` rides back so a trial can
 * observe what the call did to a fresh session state.
 */
export const ToolCallResponseSchema = z.object({
  result: z.string().optional(),
  error: z.string().optional(),
  state: z.record(z.string(), z.unknown()),
});

// ── Typed method map for the host↔guest RPC link ─────────────────────────────

/**
 * Params of the host→guest `bundle/load` request. Storage (ctx.db) rides in
 * `env` as `DATABASE_URL` — the app's own scoped credentials — and the
 * bundle's runtime connects directly, exactly as under `aai dev`.
 */
export type BundleLoadParams = {
  code: string;
  env: Record<string, string>;
};

/** Params of the host→guest `tool/execute` request (one-shot trial). */
export type ToolExecuteParams = {
  name: string;
  args: Readonly<Record<string, unknown>>;
  sessionId: string;
  /** Trial state — `null` initializes from the agent's `state()` factory. */
  state: Record<string, unknown> | null;
};

/**
 * The host's view of the sandbox control channel (see `RpcSchema` in
 * rpc-transport.ts for why method names and outgoing params are typed
 * while results and incoming params stay `unknown`: the guest is untrusted,
 * so everything it sends is validated with Zod at the receiving site —
 * e.g. `ToolCallResponseSchema`, and the studio schemas registered by the
 * session broker).
 *
 * Client voice sessions do NOT ride this link: the guest runs the complete
 * agent runtime and clients connect directly to its public `/websocket`
 * endpoint on the same tunnel.
 *
 * VERSIONING: agent sandboxes are pinned to the harness image recorded at
 * deploy time (`harness_image_tag` — see sandbox-vm.ts), so the host may be
 * newer than a pinned agent's harness. The AGENT-side methods
 * (`bundle/load`, `tool/execute`, `status`, `shutdown`) must therefore stay
 * BACKWARD compatible — additive changes only; never rename a method or
 * repurpose a param an older harness interprets differently. The studio
 * methods are exempt: studio sandboxes always spawn from the current image,
 * so that half of the contract still changes atomically with the server.
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
};

export type GuestRpcSchema = {
  requestsOut: {
    "bundle/load": { params: BundleLoadParams; result: unknown };
    "tool/execute": { params: ToolExecuteParams; result: unknown };
    "studio/session-init": { params: StudioSessionInitParams; result: unknown };
    "workspace/deploy": { params: WorkspaceDeployParams; result: unknown };
    /** Session-aware idleness: the host's idle eviction asks before killing. */
    status: { params: undefined; result: unknown };
  };
  requestsIn: {
    /** End-of-turn workspace write-back into the project store. */
    "studio/sync-workspace": { params: unknown; result: unknown };
    /** End-of-turn conversation snapshot into the project's chat row. */
    "studio/persist-chat": { params: unknown; result: unknown };
  };
  notificationsOut: {
    shutdown: undefined;
  };
  notificationsIn: Record<string, never>;
};

/** An RPC connection to a guest sandbox, typed with the guest method map. */
export type GuestConnection = RpcConnection<GuestRpcSchema>;

/**
 * Response shape of `bundle/load` when the bundle self-describes its config
 * (its `__aaiConfig` export — see the guest harness). Guest-asserted wire
 * data: callers reading `config` must treat it as unknown and validate
 * (`IsolateConfigSchema`).
 */
export type BundleLoadResult = { ok: boolean; config?: unknown };
