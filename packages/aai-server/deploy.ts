// Copyright 2025 the AAI authors. MIT license.

import { humanId } from "human-id";
import { debug } from "./_debug-log.ts";
import type { ValidatedAppContext } from "./context.ts";
import type { IsolateConfig } from "./rpc-schemas.ts";
import { type SlotCache, setSlot, terminateSlot, withSlugLock } from "./sandbox-slots.ts";
import type { AgentMetadata, DeployBody } from "./schemas.ts";
import { EnvSchema, RESERVED_SLUGS } from "./schemas.ts";
import { hashApiKey, verifyApiKeyHash } from "./secrets.ts";
import type { BundleStore } from "./store-types.ts";

/** Server-level dependencies the deploy core needs (a subset of Bindings). */
export type DeployDeps = {
  store: BundleStore;
  slots: SlotCache;
};

export type DeployParams = {
  /** Requested slug. Omit to generate one (`humanId`). */
  slug?: string | undefined;
  apiKey: string;
  worker: string;
  clientFiles: Record<string, string>;
  env?: Record<string, string> | undefined;
  /**
   * Env floor: applied only where neither the agent's stored env nor `env`
   * already supplies the key. Lets a caller seed a credential without ever
   * clobbering one the user set deliberately (`aai secret put`).
   */
  defaultEnv?: Record<string, string> | undefined;
  agentConfig: IsolateConfig;
};

export type DeployOutcome =
  | { ok: true; slug: string; message: string }
  | { ok: false; status: 400 | 403 | 409; error: string };

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
  const slug = requested ?? humanId({ separator: "-", capitalize: false });
  return withSlugLock(slug, async () => {
    // Ownership is checked whether the slug was requested or generated. A
    // generated slug used to skip this entirely, so a `humanId()` collision
    // with an existing agent would overwrite that agent's bundle and append
    // the caller's credential hash to it — silently granting a stranger
    // co-ownership. Collisions aren't attacker-targetable, but they are
    // possible, and the check costs one manifest read either way.
    const existing = await deps.store.getManifest(slug);
    const matchedHash = existing
      ? await matchAnyHash(params.apiKey, existing.credential_hashes)
      : null;
    if (existing && matchedHash === null) {
      return requested
        ? { ok: false, status: 403, error: "Forbidden: slug already owned by another user" }
        : // The caller never chose this slug, so "forbidden" would be
          // confusing — tell them to retry and get a fresh one.
          { ok: false, status: 409, error: "Slug collision on generated name — retry the deploy" };
    }
    // The matched stored hash doubles as the caller's keyHash. A fresh-salt
    // hashApiKey (~100ms, uncacheable) only runs when the slug is genuinely
    // unclaimed and a hash must be stored.
    const keyHash = matchedHash ?? (await hashApiKey(params.apiKey));
    // The check above and deployLocked run under the same slug lock, so the
    // manifest snapshot and match result can be passed through — no TOCTOU,
    // no second read, no second argon2 sweep.
    return deployLocked(deps, params, { slug, existing, matchedHash, keyHash });
  });
}

/** Resolve the first stored hash `apiKey` matches, or null when none do. */
async function matchAnyHash(apiKey: string, hashes: string[]): Promise<string | null> {
  // Verify concurrently — each cache miss costs an expensive argon2
  // derivation that runs off the main thread.
  const results = await Promise.all(
    hashes.map(async (h) => ((await verifyApiKeyHash(apiKey, h)) ? h : null)),
  );
  return results.find((h) => h !== null) ?? null;
}

/** Persist the bundle for a slug the caller is entitled to. Runs under the slug lock. */
async function deployLocked(
  deps: DeployDeps,
  params: DeployParams,
  ctx: {
    slug: string;
    /** Manifest snapshot read under the slug lock in `deployAgentBundle`. */
    existing: AgentMetadata | null;
    /** Stored hash `apiKey` matched, or null when the slug was unclaimed. */
    matchedHash: string | null;
    keyHash: string;
  },
): Promise<DeployOutcome> {
  const { slug, existing, matchedHash, keyHash } = ctx;

  const storedEnv = existing?.env ?? {};
  const env = { ...params.defaultEnv, ...storedEnv, ...params.env };

  const envParsed = EnvSchema.safeParse(env);
  if (!envParsed.success) {
    return { ok: false, status: 400, error: `Invalid platform config: ${envParsed.error.message}` };
  }

  const existingSlot = deps.slots.get(slug);
  if (existingSlot?.sandbox) {
    debug("Replacing existing deploy", { slug });
    await terminateSlot(existingSlot);
  }

  // Preserve multi-user ownership: append the deployer's hash only when no
  // stored hash already matches their key.
  const existingHashes = existing?.credential_hashes ?? [];
  const alreadyStored = matchedHash !== null || existingHashes.includes(keyHash);
  const mergedHashes = alreadyStored ? existingHashes : [...existingHashes, keyHash];

  await deps.store.putAgent({
    slug,
    env,
    worker: params.worker,
    clientFiles: params.clientFiles,
    credential_hashes: mergedHashes,
    agentConfig: params.agentConfig,
  });

  setSlot(deps.slots, { slug });

  debug("Deploy received", { slug });

  return { ok: true, slug, message: `Deployed ${slug}` };
}

// ── HTTP handlers ────────────────────────────────────────────────────────────

function outcomeToResponse(c: ValidatedAppContext<DeployBody>, outcome: DeployOutcome): Response {
  if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
  return c.json({ ok: true, slug: outcome.slug, message: outcome.message });
}

/** `POST /deploy` — deploy to the body's slug, or a server-generated one. */
export async function handleDeployNew(c: ValidatedAppContext<DeployBody>): Promise<Response> {
  const deps = { store: c.env.store, slots: c.env.slots };
  const body = c.req.valid("json");
  const outcome = await deployAgentBundle(deps, {
    slug: body.slug,
    apiKey: c.var.apiKey,
    worker: body.worker,
    clientFiles: body.clientFiles,
    env: body.env,
    agentConfig: body.agentConfig,
  });
  return outcomeToResponse(c, outcome);
}
