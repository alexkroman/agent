// Copyright 2026 the AAI authors. MIT license.
/**
 * The studio's browser-session account surface, mounted by
 * `createStudioRoutes` (studio-routes.ts owns the full route inventory):
 *
 * - `GET /studio/auth`         — public: how to sign in (Supabase/dev/none)
 * - `GET /studio/account`      — session-authed: email + whether a key is stored
 * - `PUT /studio/account/key`  — session-authed: store the AssemblyAI key
 * - `POST /studio/cli-link/approve`  — session-authed: approve an `aai login`
 *   link code, granting that one code a one-shot exchange
 * - `POST /studio/cli-link/exchange` — public: the CLI polls this with its
 *   code; once approved it returns the account's stored API key (one-shot)
 *
 * These routes authenticate the browser session WITHOUT requiring a stored
 * AssemblyAI key — they are how the key gets set. Everything under
 * /projects goes through authMw instead, which resolves the session to the
 * stored key (and 401s until one exists).
 */

import { zValidator } from "@hono/zod-validator";
import {
  invalidateApiKeyOwner,
  invalidateUserApiKey,
  requireStudioUser,
} from "aai-server/middleware";
import {
  apiKeyOwnerSecretName,
  cliLinkSecretName,
  userApiKeySecretName,
} from "aai-server/supabase-auth";
import type { Hono } from "hono";
import type { StudioHonoEnv } from "./studio-context.ts";
import { AccountKeySchema, CliLinkSchema } from "./studio-schemas.ts";

/**
 * An approved `aai login` link, stored (JSON) in the SecretStore under the
 * code's hash until the CLI exchanges it. Short-lived: the CLI polls every
 * couple of seconds, so an uncollected grant means the CLI died — the
 * expiry keeps its code from being redeemable later.
 */
type CliLinkGrant = { uid: string; email?: string; exp: number };
const CLI_LINK_TTL_MS = 10 * 60_000;

function parseCliLinkGrant(raw: string): CliLinkGrant | null {
  try {
    const grant = JSON.parse(raw) as Partial<CliLinkGrant> | null;
    if (!grant || typeof grant.uid !== "string" || typeof grant.exp !== "number") return null;
    return grant as CliLinkGrant;
  } catch {
    return null;
  }
}

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
      ...(user.email && { email: user.email }),
      exp: Date.now() + CLI_LINK_TTL_MS,
    };
    await c.env.secrets.put(cliLinkSecretName(c.req.valid("json").code), JSON.stringify(grant));
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
    const grant = parseCliLinkGrant(raw);
    if (!grant || grant.exp < Date.now()) {
      return c.json({ error: "Link approval expired — run `aai login` again" }, 410);
    }
    const key = await c.env.secrets.get(userApiKeySecretName(grant.uid));
    if (!key) return c.json({ error: "No API key on file for this account" }, 409);
    return c.json({ apiKey: key, ...(grant.email && { email: grant.email }) });
  });
}
