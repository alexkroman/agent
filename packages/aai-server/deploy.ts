// Copyright 2025 the AAI authors. MIT license.

import { errorMessage } from "@alexkroman1/aai";
import { requiredProviderEnvVars } from "@alexkroman1/aai/runtime";
import { debug } from "./_debug-log.ts";
import type { AgentRecord } from "./agent-store.ts";
import type { ValidatedAppContext } from "./context.ts";
import { localSlugLock, type SlugMutationLock } from "./platform-lock.ts";
import { type IsolateConfig, IsolateConfigSchema } from "./rpc-schemas.ts";
import type { DeployBody } from "./schemas.ts";
import { EnvSchema, RESERVED_SLUGS } from "./schemas.ts";
import { hashApiKey, matchAnyHash } from "./secrets.ts";
import { generatedSlug, slugBaseFromName } from "./slug-generate.ts";
import type { BundleStore } from "./store-types.ts";

/** Server-level dependencies the deploy core needs (a subset of Bindings). */
export type DeployDeps = {
  store: BundleStore;
  /**
   * Per-slug mutation lock. Cross-replica (Postgres lease) in production;
   * defaults to the in-process lock for tests and single-replica callers.
   */
  slugLock?: SlugMutationLock | undefined;
  /**
   * The harness snapshot image tag new sandboxes currently spawn from —
   * recorded on the agents row so this deploy keeps running on the SAME
   * guest image across platform upgrades (see `currentHarnessImageTag` in
   * sandbox-vm.ts). Absent (tests) or resolving null (subprocess backend)
   * records no pin.
   */
  harnessImageTag?: (() => Promise<string | null>) | undefined;
};

export type DeployParams = {
  /** Requested slug. Omit to generate one (`generatedSlug`). */
  slug?: string | undefined;
  apiKey: string;
  worker: string;
  clientFiles: Record<string, string>;
  env?: Record<string, string> | undefined;
  agentConfig: IsolateConfig;
  /**
   * What to do when the agent's config requires a credential the merged env
   * doesn't hold (see {@link missingCredentials}). `"require"` (the default)
   * rejects the deploy with a 400 naming the keys — the fix is one `.env`
   * edit away for CLI callers. `"warn"` deploys anyway and returns the names
   * in `DeployOutcome.warnings`: the studio uses this because it has no
   * secrets UI, so a hard failure would leave its user with no path forward.
   */
  credentialPolicy?: "require" | "warn" | undefined;
};

export type DeployOutcome =
  | { ok: true; slug: string; message: string; warnings?: string[] }
  | { ok: false; status: 400 | 403 | 409; error: string };

/**
 * Extracts an agent's config from its worker bundle — in production, by
 * loading the bundle in a throwaway guest sandbox (`describeBundle`) and
 * returning its `__aaiConfig` self-description. Never evaluates tenant code
 * on the host.
 */
export type BundleInspector = (workerCode: string) => Promise<unknown>;

export type ConfigExtraction = { ok: true; config: IsolateConfig } | { ok: false; error: string };

/**
 * Validate a bundle-extracted raw config. The raw value always comes from
 * evaluating the bundle inside a guest sandbox — via `describeBundle` on
 * the HTTP deploy path, or riding back with the artifacts from the guest's
 * `workspace/deploy` on the studio path — never from anything a client sent.
 */
export function validateAgentConfig(raw: unknown): ConfigExtraction {
  if (raw === undefined) {
    return {
      ok: false,
      error:
        "Worker bundle does not self-describe its config — rebuild it with a current @alexkroman1/aai-cli",
    };
  }
  const parsed = IsolateConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => i.message).join("; ");
    return { ok: false, error: `Invalid agent config: ${issues}` };
  }
  return { ok: true, config: parsed.data };
}

/**
 * Derive and validate an agent's config from its worker bundle by loading
 * it in a throwaway guest sandbox (the HTTP deploy route's path).
 */
export async function extractAgentConfig(
  inspect: BundleInspector,
  worker: string,
): Promise<ConfigExtraction> {
  let raw: unknown;
  try {
    raw = await inspect(worker);
  } catch (err) {
    return { ok: false, error: `Agent bundle failed to load: ${errorMessage(err)}` };
  }
  return validateAgentConfig(raw);
}

/**
 * Deploy an agent bundle: claim (or re-claim) the slug under its lock,
 * verify ownership, and persist the bundle. Shared by the HTTP deploy
 * handlers and the browser studio's deploy tool so ownership semantics
 * have a single source of truth.
 */
export function deployAgentBundle(deps: DeployDeps, params: DeployParams): Promise<DeployOutcome> {
  const requested = params.slug;
  // Single choke point for reserved names — programmatic callers (the studio
  // deploy tool) don't pass through DeployBodySchema.
  if (requested && RESERVED_SLUGS.has(requested)) {
    return Promise.resolve({ ok: false as const, status: 400 as const, error: "Reserved slug" });
  }
  // No requested slug: generate one from the agent's own display name (its
  // bundle-described config) plus a random suffix — the same generator the
  // studio uses for prompt-derived project names. An unusable name (empty
  // after slugification) falls back to random words inside the generator.
  const slug = requested ?? generatedSlug(slugBaseFromName(params.agentConfig.name));
  const lock = deps.slugLock ?? localSlugLock;
  return lock(slug, async () => {
    // Ownership is checked whether the slug was requested or generated. A
    // generated slug used to skip this entirely, so a generated-name
    // collision with an existing agent would overwrite that agent's bundle
    // and append the caller's credential hash to it — silently granting a
    // stranger co-ownership. The random suffix makes collisions negligible
    // but not impossible, and the check costs one row read either way.
    const existing = await deps.store.getAgent(slug);
    const matchedHash = existing ? matchAnyHash(params.apiKey, existing.credential_hashes) : null;
    if (existing && matchedHash === null) {
      return requested
        ? { ok: false, status: 403, error: "Forbidden: slug already owned by another user" }
        : // The caller never chose this slug, so "forbidden" would be
          // confusing — tell them to retry and get a fresh one.
          { ok: false, status: 409, error: "Slug collision on generated name — retry the deploy" };
    }
    const keyHash = matchedHash ?? hashApiKey(params.apiKey);
    // The check above and deployLocked run under the same slug lock, so the
    // record snapshot and match result can be passed through — no TOCTOU,
    // no second read.
    return deployLocked(deps, params, { slug, existing, matchedHash, keyHash });
  });
}

/**
 * Env var names the agent needs but the merged env doesn't supply (empty
 * values count as missing — an empty credential authenticates nothing).
 *
 * Two sources, both from the bundle's self-described config so a client
 * can't understate them: provider credentials derived from the
 * stt/llm/tts/s2s descriptors (the same registry-backed derivation the
 * runtime resolves keys with), and the agent's own declared `requiredEnv`.
 * This is what turns "works locally, dies at first session after deploy" —
 * an agent that ran on shell-exported keys `aai dev` falls back to but the
 * platform never will — into a deploy-time message naming the key.
 */
export function missingCredentials(config: IsolateConfig, env: Record<string, string>): string[] {
  const required = new Set([...requiredProviderEnvVars(config), ...(config.requiredEnv ?? [])]);
  return [...required].filter((name) => !env[name]);
}

function missingCredentialMessage(missing: string[]): string {
  const plural = missing.length > 1;
  return (
    `Missing credential${plural ? "s" : ""} the agent needs to start: ${missing.join(", ")}. ` +
    `Declare ${plural ? "them" : "it"} in .env and redeploy ` +
    "(an already-deployed agent can also be updated with `aai secret put`)."
  );
}

/** Persist the bundle for a slug the caller is entitled to. Runs under the slug lock. */
async function deployLocked(
  deps: DeployDeps,
  params: DeployParams,
  ctx: {
    slug: string;
    /** Agent-record snapshot read under the slug lock in `deployAgentBundle`. */
    existing: AgentRecord | null;
    /** Stored hash `apiKey` matched, or null when the slug was unclaimed. */
    matchedHash: string | null;
    keyHash: string;
  },
): Promise<DeployOutcome> {
  const { slug, existing, matchedHash, keyHash } = ctx;

  // The env floor (seeding a caller's own key where nothing else supplies it)
  // is the CLI's job now — `aai deploy` merges it into `env` client-side, and
  // studio Publish runs that same CLI in-guest. The server-side `defaultEnv`
  // that used to do it had no caller left.
  const storedEnv = existing ? ((await deps.store.getEnv(slug)) ?? {}) : {};
  const env = { ...storedEnv, ...params.env };

  const envParsed = EnvSchema.safeParse(env);
  if (!envParsed.success) {
    return { ok: false, status: 400, error: `Invalid platform config: ${envParsed.error.message}` };
  }

  // Credential preflight: the config is the bundle's own self-description,
  // so the required set can't be understated by the client. Checked before
  // any side effect — a rejected deploy must leave the live sandbox running.
  const missing = missingCredentials(params.agentConfig, env);
  if (missing.length > 0 && (params.credentialPolicy ?? "require") === "require") {
    return { ok: false, status: 400, error: missingCredentialMessage(missing) };
  }

  // Preserve multi-user ownership: append the deployer's hash only when no
  // stored hash already matches their key.
  const existingHashes = existing?.credential_hashes ?? [];
  const alreadyStored = matchedHash !== null || existingHashes.includes(keyHash);
  const mergedHashes = alreadyStored ? existingHashes : [...existingHashes, keyHash];

  // Best-effort pin: a failed tag computation must not fail the deploy —
  // the agent just runs unpinned (the pre-pinning behavior).
  const harnessImageTag = await (deps.harnessImageTag?.() ?? Promise.resolve(null)).catch(
    () => null,
  );

  await deps.store.putAgent({
    slug,
    env,
    worker: params.worker,
    clientFiles: params.clientFiles,
    credential_hashes: mergedHashes,
    agentConfig: params.agentConfig,
    harnessImageTag,
  });

  // The row upsert IS the invalidation: it bumps the deploy version, and the
  // agents row's change stream retires every replica's superseded resident —
  // this one's included (see watchAgentInvalidation in sandbox-resolve.ts).
  // No local slot surgery here: mutation handlers write rows, the change
  // stream moves sandboxes.

  debug("Deploy received", { slug });

  return {
    ok: true,
    slug,
    message: `Deployed ${slug}`,
    ...(missing.length > 0 ? { warnings: [missingCredentialMessage(missing)] } : {}),
  };
}

// ── HTTP handlers ────────────────────────────────────────────────────────────

function outcomeToResponse(c: ValidatedAppContext<DeployBody>, outcome: DeployOutcome): Response {
  if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
  return c.json({
    ok: true,
    slug: outcome.slug,
    message: outcome.message,
    ...(outcome.warnings ? { warnings: outcome.warnings } : {}),
  });
}

/**
 * `POST /deploy` — deploy to the body's slug, or a server-generated one.
 *
 * The agent config is derived from the uploaded worker inside a guest
 * sandbox (`inspect`), never taken from the request: a client-supplied
 * config would let a caller deploy a bundle whose declared capabilities
 * (providers, tools) disagree with the code that runs.
 */
export async function handleDeployNew(
  c: ValidatedAppContext<DeployBody>,
  inspect: BundleInspector,
  harnessImageTag?: () => Promise<string | null>,
): Promise<Response> {
  const deps = {
    store: c.env.store,
    slugLock: c.env.slugLock,
    harnessImageTag,
  };
  const body = c.req.valid("json");
  const extraction = await extractAgentConfig(inspect, body.worker);
  if (!extraction.ok) return c.json({ error: extraction.error }, 400);
  const outcome = await deployAgentBundle(deps, {
    slug: body.slug,
    apiKey: c.var.apiKey,
    worker: body.worker,
    clientFiles: body.clientFiles,
    env: body.env,
    agentConfig: extraction.config,
    credentialPolicy: body.credentialPolicy,
  });
  return outcomeToResponse(c, outcome);
}
