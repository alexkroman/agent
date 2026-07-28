// Copyright 2025 the AAI authors. MIT license.

import { humanId } from "human-id";
import { debug } from "./_debug-log.ts";
import type { ValidatedAppContext } from "./context.ts";
import type { IsolateConfig } from "./rpc-schemas.ts";
import { type SlotCache, setSlot, terminateSlot, withSlugLock } from "./sandbox-slots.ts";
import type { DeployBody } from "./schemas.ts";
import { EnvSchema, RESERVED_SLUGS } from "./schemas.ts";
import { verifyApiKeyHash } from "./secrets.ts";
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
  keyHash: string;
  worker: string;
  clientFiles: Record<string, string>;
  env?: Record<string, string> | undefined;
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
    if (existing && !(await matchesAnyHash(params.apiKey, existing.credential_hashes))) {
      return requested
        ? { ok: false, status: 403, error: "Forbidden: slug already owned by another user" }
        : // The caller never chose this slug, so "forbidden" would be
          // confusing — tell them to retry and get a fresh one.
          { ok: false, status: 409, error: "Slug collision on generated name — retry the deploy" };
    }
    return deployLocked(deps, params, slug);
  });
}

async function matchesAnyHash(apiKey: string, hashes: string[]): Promise<boolean> {
  // Verify concurrently — each cache miss costs ~100ms of PBKDF2, and
  // deriveBits runs off the main thread.
  const results = await Promise.all(hashes.map((h) => verifyApiKeyHash(apiKey, h)));
  return results.some(Boolean);
}

/** Persist the bundle for a slug the caller is entitled to. Runs under the slug lock. */
async function deployLocked(
  deps: DeployDeps,
  params: DeployParams,
  slug: string,
): Promise<DeployOutcome> {
  const { apiKey, keyHash } = params;

  const storedEnv = (await deps.store.getEnv(slug)) ?? {};
  const env = params.env ? { ...storedEnv, ...params.env } : storedEnv;

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
  const existingHashes = (await deps.store.getManifest(slug))?.credential_hashes ?? [];
  const alreadyStored =
    existingHashes.includes(keyHash) || (await matchesAnyHash(apiKey, existingHashes));
  const mergedHashes = alreadyStored ? existingHashes : [...existingHashes, keyHash];

  await deps.store.putAgent({
    slug,
    env,
    worker: params.worker,
    clientFiles: params.clientFiles,
    credential_hashes: mergedHashes,
    agentConfig: params.agentConfig,
  });

  setSlot(deps.slots, { slug, keyHash });

  debug("Deploy received", { slug });

  return { ok: true, slug, message: `Deployed ${slug}` };
}

// ── HTTP handlers ────────────────────────────────────────────────────────────

function outcomeToResponse(c: ValidatedAppContext<DeployBody>, outcome: DeployOutcome): Response {
  if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
  return c.json({ ok: true, slug: outcome.slug, message: outcome.message });
}

function paramsFromBody(c: ValidatedAppContext<DeployBody>, slug?: string): DeployParams {
  const body = c.req.valid("json");
  return {
    slug,
    apiKey: c.var.apiKey,
    keyHash: c.var.keyHash,
    worker: body.worker,
    clientFiles: body.clientFiles,
    env: body.env,
    agentConfig: body.agentConfig,
  };
}

/** `POST /:slug/deploy` — deploy to a caller-chosen slug (ownership via `ownerMw`). */
export async function handleDeploy(c: ValidatedAppContext<DeployBody>): Promise<Response> {
  const deps = { store: c.env.store, slots: c.env.slots };
  const outcome = await deployAgentBundle(deps, paramsFromBody(c, c.var.slug));
  return outcomeToResponse(c, outcome);
}

/** `POST /deploy` — deploy to the body's slug, or a server-generated one. */
export async function handleDeployNew(c: ValidatedAppContext<DeployBody>): Promise<Response> {
  const deps = { store: c.env.store, slots: c.env.slots };
  const outcome = await deployAgentBundle(deps, paramsFromBody(c, c.req.valid("json").slug));
  return outcomeToResponse(c, outcome);
}
