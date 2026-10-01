// Copyright 2025 the AAI authors. MIT license.
/**
 * The agent's env under `aai dev` and `aai console`: `.env`-declared keys, the
 * login-key fallback for AssemblyAI, and the credential warnings. Split out of
 * `_dev-server.ts` (file-length cap); the server is its main consumer.
 */

import type { AgentDef } from "@alexkroman1/aai";
import { agentRequiredEnv } from "@alexkroman1/aai/internal";
import { agentConfigWarnings } from "@alexkroman1/aai/manifest";
import { plural } from "@alexkroman1/aai/utils";
import { requiredProviderEnvVars } from "@alexkroman1/aai-runtime/internal";
import { ensureApiKey } from "./_config.ts";
import { resolveServerEnv } from "./_server-common.ts";
import { defaultUi, type Ui } from "./_ui.ts";

/**
 * Warnings about the agent's credentials, computed against the `.env`-derived
 * env and the shell. Pure so it is directly testable; `resolveAgentEnv` logs
 * each entry. Three cases, in increasing subtlety:
 *
 * - a provider key found nowhere → the first session will fail auth;
 * - a provider key found only in the shell → works here (the
 *   `withHostCredentialFallback` ergonomic) but is invisible to `aai deploy`,
 *   which uploads `.env` — the classic "works locally, dead on deploy";
 * - a `requiredEnv` key, MCP `tokenEnv` or keyed builtin's key absent from
 *   `.env` → `ctx.env` won't contain it at all: custom keys never fall back to
 *   the shell, so a shell export can't mask one missing here and after deploy.
 */
export function agentEnvWarnings(
  // `mode` because a workflow app needs no provider credential at all — see
  // `requiredProviderEnvVars`.
  agentDef: Pick<
    AgentDef,
    "stt" | "llm" | "tts" | "s2s" | "requiredEnv" | "mode" | "mcpServers" | "builtinTools"
  >,
  env: Record<string, string>,
  shellEnv: Record<string, string | undefined> = process.env,
): string[] {
  // Derived from the provider registries, so a new provider needs no change here.
  const required = requiredProviderEnvVars(agentDef);
  const warnings: string[] = [];

  const missing = required.filter((name) => !(env[name] || shellEnv[name]));
  if (missing.length > 0) {
    warnings.push(
      `Missing provider ${plural(missing.length, "credential")}: ${missing.join(", ")}. ` +
        `Set ${plural(missing.length, "it", "them")} in .env or the environment.`,
    );
  }

  const shellOnly = required.filter((name) => !env[name] && shellEnv[name]);
  if (shellOnly.length > 0) {
    warnings.push(
      `${shellOnly.join(", ")} resolved from your shell, not .env — ` +
        `deployed agents won't have ${plural(shellOnly.length, "it", "them")}. ` +
        `Declare ${plural(shellOnly.length, "it", "them")} in .env before \`aai publish\`.`,
    );
  }

  const declared = agentRequiredEnv(agentDef).filter((name) => !env[name]);
  if (declared.length > 0) {
    warnings.push(
      `Missing ${plural(declared.length, "key")} the agent declares (requiredEnv, an MCP ` +
        "tokenEnv or a keyed builtin): " +
        `${declared.join(", ")}. Set ${plural(declared.length, "it", "them")} in .env — ` +
        `ctx.env will not contain ${plural(declared.length, "it", "them")} otherwise.`,
    );
  }
  return warnings;
}

/** What {@link resolveAgentEnv} reads the login key through — a seam for specs. */
export type AgentEnvDeps = { ensureApiKey: typeof ensureApiKey };

export async function resolveAgentEnv(
  root: string,
  agentDef: AgentDef,
  ui: Ui = defaultUi,
  deps: AgentEnvDeps = { ensureApiKey },
): Promise<Record<string, string>> {
  const env = await resolveServerEnv(root);

  // Only AssemblyAI's key has a setup flow of its own (it doubles as the
  // platform credential), so that one falls back to the logged-in key.
  //
  // A shell-exported key is deliberately checked FIRST and left out of `env`:
  // `withHostCredentialFallback` (below, in `buildServer`) already routes it
  // to the provider resolvers without letting it into `ctx.env`, and
  // `agentEnvWarnings` flags it as shell-only so the "works here, dead after
  // deploy" case stays visible. Without this check `aai dev` would hard-fail
  // on a missing LOGIN for a developer whose key is exported the usual way,
  // since `ensureApiKey` reads the login key and nothing else.
  //
  // `"local-session"` is what keeps the FAILURE credential-shaped: nothing
  // here needs a platform account, so the refusal names `.env` and a shell
  // export before `aai login`. See {@link ApiKeyUse}.
  const required = requiredProviderEnvVars(agentDef);
  const hasShellKey = Boolean(process.env.ASSEMBLYAI_API_KEY);
  if (required.includes("ASSEMBLYAI_API_KEY") && !env.ASSEMBLYAI_API_KEY && !hasShellKey) {
    env.ASSEMBLYAI_API_KEY = await deps.ensureApiKey(undefined, "local-session");
  }

  // Anything still unresolved would otherwise surface as an auth failure on
  // the first session (or a deploy-time rejection) — warn now. Through
  // `notify`, not `log.warn`: `aai dev` is long-running, so JSON mode (which a
  // pipe auto-selects) has already silenced `log` and the first session then
  // fails auth with nothing having said why. See this package's CLAUDE.md.
  for (const warning of agentEnvWarnings(agentDef, env)) ui.notify("warn", warning);
  // The config's own warnings — a TTS/S2S voice outside the catalog, which is
  // otherwise reported by nothing until the first session is silent.
  for (const warning of agentConfigWarnings(agentDef)) ui.notify("warn", warning);
  return env;
}
