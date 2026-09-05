// Copyright 2026 the AAI authors. MIT license.
/**
 * The studio's browser-session account surface, mounted by
 * `createStudioRoutes` (studio-routes.ts owns the full route inventory):
 *
 * - `GET /studio/auth`         — public: how to sign in (Supabase/dev/none)
 * - `GET /studio/account`      — session-authed: email + whether a key is stored
 * - `PUT /studio/account/key`  — session-authed: store the AssemblyAI key
 * - `POST /studio/cli-link/approve`  — session-authed: approve an `aai login`
 *   link code, granting that one code a one-shot exchange (and backfilling
 *   the key→user mapping that puts the linked CLI in this account's scope)
 * - `POST /studio/cli-link/exchange` — public: the CLI polls this with its
 *   code; once approved it returns the account's stored API key (one-shot)
 *
 * These routes authenticate the browser session WITHOUT requiring a stored
 * AssemblyAI key — they are how the key gets set. Everything under
 * /projects goes through authMw instead, which resolves the session to the
 * stored key (and 401s until one exists).
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import { zValidator } from "@hono/zod-validator";
import {
  apiKeyOwnerSecretName,
  cliLinkSecretName,
  invalidateApiKeyOwner,
  invalidateUserApiKey,
  requireStudioUser,
  userApiKeySecretName,
} from "aai-server/http";
import type { Hono } from "hono";
import { z } from "zod";
import type { StudioHonoEnv } from "./studio-context.ts";
import { AccountKeySchema, CliLinkSchema } from "./studio-schemas.ts";
import { parseJsonSecret, writeJsonSecret } from "./studio-secret-record.ts";

/**
 * An approved `aai login` link, stored (JSON) in the SecretStore under the
 * code's hash until the CLI exchanges it. Short-lived: the CLI polls every
 * couple of seconds, so an uncollected grant means the CLI died — the
 * expiry keeps its code from being redeemable later.
 *
 * Validated by a SCHEMA rather than by hand-written field checks, and by
 * `safeJsonParse` rather than a bare `try { JSON.parse }`. It is worth the
 * ceremony because of what this record buys whoever presents it: exactly one
 * exchange for an account's raw AssemblyAI key. A hand-rolled guard that
 * checks two fields and casts is one edit away from admitting a shape the
 * exchange then reads as somebody else's `uid`.
 */
const CliLinkGrantSchema = z.object({
  uid: z.string().min(1),
  email: z.string().optional(),
  exp: z.number(),
});
type CliLinkGrant = z.infer<typeof CliLinkGrantSchema>;
const CLI_LINK_TTL_MS = 10 * 60_000;

export function registerAccountRoutes(studio: Hono<StudioHonoEnv>): void {
  // Public: what the login screen should render — Supabase GitHub-OAuth
  // config, the local-dev sign-in, or nothing (browser login unconfigured).
  studio.get("/auth", (c) => c.json(c.env.auth?.clientConfig ?? { mode: "none" }));

  studio.get("/account", async (c) => {
    const user = await requireStudioUser(c.req.raw, c.env);
    const key = await c.env.secrets.get(userApiKeySecretName(user.id));
    return c.json({ ...(user.email && { email: user.email }), hasKey: key !== null });
  });

  studio.put("/account/key", zValidator("json", AccountKeySchema), async (c) => {
    const user = await requireStudioUser(c.req.raw, c.env);
    const { apiKey } = c.req.valid("json");
    // This is the OTHER half of key verification (api-key-verify.ts). The
    // request path verifies raw bearers; a browser session never presents a
    // key at all, so without this an account could store an arbitrary string
    // and every later request would resolve to it having skipped the check —
    // the stored key IS the credential for deploys, ownership hashes, and the
    // gateway. Verifying at the point of storage means it happens once.
    if (c.env.keyVerifier) {
      let valid: boolean;
      try {
        valid = await c.env.keyVerifier(apiKey);
      } catch {
        return c.json({ error: "Could not verify that key right now — try again shortly" }, 503);
      }
      if (!valid) return c.json({ error: "That is not a valid AssemblyAI API key" }, 400);
    }
    // A key belongs to ONE account. Rebinding one that another account
    // already claimed is how key knowledge becomes durable capture: the
    // victim's CLI authenticates with the raw key, resolves scope through
    // this mapping, and silently lands in the attacker's studio scope, where
    // `aai push` writes the victim's source into the attacker's workspace.
    // Both scopes stay internally consistent, so nothing on either side ever
    // reports a problem. Last-writer-wins was documented as benign for a
    // shared team key; the shared-key case is the one that must give up
    // something, and a 409 it can see beats a silent redirect it cannot.
    const currentOwner = await c.env.secrets.get(apiKeyOwnerSecretName(apiKey));
    if (currentOwner !== null && currentOwner !== user.id) {
      return c.json({ error: "That API key is already linked to another account" }, 409);
    }
    // Both directions: the session→key lookup every JWT request rides, and
    // the key→user reverse mapping that lands raw-key callers (`aai login`'d
    // CLIs) in this user's studio scope. See apiKeyOwnerSecretName for the
    // rotation/shared-key semantics.
    await Promise.all([
      c.env.secrets.put(userApiKeySecretName(user.id), apiKey),
      c.env.secrets.put(apiKeyOwnerSecretName(apiKey), user.id),
    ]);
    // A rotated key must take effect on this replica's next request, not
    // after the resolver caches' TTL.
    invalidateUserApiKey(c.env.secrets, user.id);
    invalidateApiKeyOwner(c.env.secrets, apiKey);
    return c.json({ ok: true });
  });

  // `aai login` device link: the CLI never signs in (and can never create
  // an account) — it mints an unguessable one-shot code, opens the studio
  // with `?cli-link=<code>`, and polls the exchange route below. A browser
  // session that is ALREADY signed in approves the code here, which grants
  // that code one exchange for the account's stored key. Approval requires
  // a stored key (the studio's own key gate runs first), so the CLI never
  // participates in onboarding.
  studio.post("/cli-link/approve", zValidator("json", CliLinkSchema), async (c) => {
    const user = await requireStudioUser(c.req.raw, c.env);
    const key = await c.env.secrets.get(userApiKeySecretName(user.id));
    if (!key) return c.json({ error: "No API key on file for this account" }, 409);
    const grant: CliLinkGrant = {
      uid: user.id,
      ...omitUndefined({ email: user.email }),
      exp: Date.now() + CLI_LINK_TTL_MS,
    };
    await writeJsonSecret(c.env.secrets, cliLinkSecretName(c.req.valid("json").code), grant);
    return c.json({ ok: true });
  });

  // Public, but only ever useful to whoever minted the code: 256 bits of
  // entropy make guessing hopeless, the grant is deleted on first read
  // (one-shot — a replayed exchange gets a 404), and an approved-but-never-
  // collected grant expires. Revealing the key to the code's owner adds no
  // authority the approving session didn't already have: every studio
  // surface can already spend and deploy with it. Unlike the browser, the
  // CLI genuinely needs the RAW key (`aai dev` runs the provider pipeline
  // in-process on it).
  studio.post("/cli-link/exchange", zValidator("json", CliLinkSchema), async (c) => {
    const name = cliLinkSecretName(c.req.valid("json").code);
    const raw = await c.env.secrets.get(name);
    if (raw === null) return c.json({ pending: true }, 404);
    await c.env.secrets.delete(name);
    const grant = parseJsonSecret(raw, CliLinkGrantSchema);
    if (!grant || grant.exp < Date.now()) {
      return c.json({ error: "Link approval expired — run `aai login` again" }, 410);
    }
    const key = await c.env.secrets.get(userApiKeySecretName(grant.uid));
    if (!key) return c.json({ error: "No API key on file for this account" }, 409);
    return c.json({ apiKey: key, ...omitUndefined({ email: grant.email }) });
  });
}
