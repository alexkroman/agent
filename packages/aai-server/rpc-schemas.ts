// Copyright 2025 the AAI authors. MIT license.
/**
 * Zod schemas for the host ↔ guest RPC boundary.
 *
 * The isolate (harness-runtime.ts) is self-contained and uses inline type
 * definitions instead of importing these schemas, so host and guest can
 * evolve independently.
 */

import type { Message } from "@alexkroman1/aai";
import { AllowedHostsSchema, DEFAULT_SYSTEM_PROMPT, errorMessage } from "@alexkroman1/aai";
import {
  AgentConfigSchema,
  assertPipelineTuning,
  assertProviderTriple,
  assertSilencePolicy,
  ToolSchemaSchema,
} from "@alexkroman1/aai/manifest";
import { z } from "zod";
import type { MessagesMode } from "./guest/harness-messages.ts";
import type { NdjsonConnection } from "./ndjson-transport.ts";
import type {
  FetchResponseChunk,
  FetchResponseEnd,
  FetchResponseError,
  FetchResponseStart,
} from "./sandbox-fetch.ts";

export { ToolSchemaSchema } from "@alexkroman1/aai/manifest";

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
  // none (toRuntimeAgent falls back to ""), never the SDK default phrase.
  systemPrompt: z.string().default(DEFAULT_SYSTEM_PROMPT),
  greeting: z.string().optional(),
  // Re-validated host-side, not trusted: this list arrives from a tenant's
  // bundle and decides that agent's guest egress, so the platform applies
  // the same pattern rules the SDK does rather than assuming the CLI ran
  // them. Rejects protocols, paths, ports, IP literals, bare `*`, and
  // private TLDs; the SSRF guard still screens every request on top.
  allowedHosts: AllowedHostsSchema.default([]),
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

/**
 * Params for the guest→host `db/query` RPC — one parameterized SQL statement
 * run against the app's provisioned database (ctx.db). Result is the rows
 * array, capped host-side (see sandbox-guest-rpc.ts).
 */
export const DbQueryParamsSchema = z.object({
  sql: z.string().min(1),
  params: z.array(z.unknown()).optional(),
});

// Zod strips unknown keys, so a legacy guest that still echoes per-session
// `state` on a tool response parses fine — the host only ever reads `result`.
export const ToolCallResponseSchema = z.object({
  result: z.string(),
});

/**
 * Response of the host→guest `session/export` request. Guest-asserted wire
 * data; an absent `state` means the session had none to export.
 */
export const SessionExportResultSchema = z.object({
  state: z.record(z.string(), z.unknown()).optional(),
});

// ── Typed method map for the host↔guest NDJSON link ─────────────────────────

/** Params of the host→guest `bundle/load` request. */
export type BundleLoadParams = {
  code: string;
  env: Record<string, string>;
  /**
   * Whether ctx.db is live (proxied over db/query) or should throw the
   * storage-not-enabled guidance. The guest schema defaults it to false;
   * senders that know their intent state it explicitly.
   */
  storageEnabled?: boolean;
};

/** Params of the host→guest `tool/execute` request. */
export type ToolExecuteParams = {
  name: string;
  args: Readonly<Record<string, unknown>>;
  sessionId: string;
  /** Conversation history — full or a delta, per `messagesMode`. */
  messages: readonly Message[];
  messagesMode?: MessagesMode;
  messagesBase?: number;
};

/**
 * The host's view of the sandbox NDJSON link (see `RpcSchema` in
 * ndjson-transport.ts for why method names and outgoing params are typed
 * while results and incoming params stay `unknown`: the guest is untrusted,
 * so everything it sends is validated with Zod at the receiving site —
 * `ToolCallResponseSchema`, `DbQueryParamsSchema`, and the schemas in
 * sandbox-guest-rpc.ts).
 *
 * This map and the guest harness must agree; the harness is deliberately
 * self-contained (inline types, no imports from here), so the wire contract
 * is pinned by `sandbox-compat.test.ts` fixtures rather than shared types.
 */
export type GuestRpcSchema = {
  requestsOut: {
    "bundle/load": { params: BundleLoadParams; result: unknown };
    "tool/execute": { params: ToolExecuteParams; result: unknown };
    // Snapshot one session's guest ctx.state for cross-replica resume
    // persistence; `{}` result means the session has no state to export.
    "session/export": { params: { sessionId: string }; result: unknown };
  };
  requestsIn: {
    "db/query": { params: unknown; result: unknown };
    "vector/upsert": { params: unknown; result: unknown };
    "vector/query": { params: unknown; result: unknown };
    "vector/delete": { params: unknown; result: unknown };
    "llm/generate": { params: unknown; result: unknown };
    "fetch/request": { params: unknown; result: { id: string } };
  };
  notificationsOut: {
    "session/end": { sessionId: string };
    // Persisted ctx.state for a resumed session; guest applies set-if-absent.
    "session/restore": { sessionId: string; state: Record<string, unknown> };
    shutdown: undefined;
    // Host-liveness heartbeat (modal-sandbox.ts). The guest deliberately has
    // no `ping` handler — any inbound line feeds its orphan watchdog — but the
    // method still belongs in the contract, or sending it doesn't typecheck.
    ping: undefined;
    "fetch/response-start": FetchResponseStart;
    "fetch/response-chunk": FetchResponseChunk;
    "fetch/response-end": FetchResponseEnd;
    "fetch/response-error": FetchResponseError;
  };
  notificationsIn: {
    "client/send": unknown;
  };
};

/** An NDJSON connection to a guest sandbox, typed with the guest method map. */
export type GuestConnection = NdjsonConnection<GuestRpcSchema>;

/**
 * Response shape of `bundle/load` when the bundle self-describes its config
 * (its `__aaiConfig` export — see the guest harness). Guest-asserted wire
 * data: callers reading `config` must treat it as unknown and validate
 * (`IsolateConfigSchema`).
 */
export type BundleLoadResult = { ok: boolean; config?: unknown };
