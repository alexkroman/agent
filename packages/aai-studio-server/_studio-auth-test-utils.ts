// Copyright 2026 the AAI authors. MIT license.
/**
 * Dev-auth scaffolding shared by every suite that signs a browser session in.
 *
 * Four files wrote the same three things by hand: the dev token the login
 * screen mints (four verbatim copies of one base64url expression), the
 * `createTestCombined({ auth: createDevAuth() })` harness, and the onboarding
 * `PUT /studio/account/key` that has to run before any project route will
 * accept a session (open-coded in five places).
 *
 * A copy of a credential-shaped literal is the kind that drifts silently: the
 * token's `id` is what `studioScope` derives a browser caller's whole
 * namespace from, so a fifth copy spelling it `${email}` instead of
 * `dev:${email}` would put that suite in a scope of its own and every
 * assertion in it would still pass.
 */

import { createDevAuth } from "aai-server/supabase-auth";
import { authFetch, type TestFetch } from "aai-server/test-utils";
import { createTestCombined } from "./_test-combined.ts";

/** A dev-auth browser session token, the way the login screen mints one. */
export const devToken = (email: string): string =>
  `dev.${Buffer.from(JSON.stringify({ id: `dev:${email}`, email }))
    .toString("base64url")
    .replace(/=+$/, "")}.dev`;

/** The combined harness with dev auth wired in. */
export const withDevAuth = (
  overrides: Parameters<typeof createTestCombined>[0] = {},
): ReturnType<typeof createTestCombined> =>
  createTestCombined({ auth: createDevAuth(), ...overrides });

/**
 * The mandatory onboarding PUT: bind an AssemblyAI key to the signed-in
 * account. Returned rather than awaited to nothing, because several suites
 * assert on its status (200, 400 for a JWT-shaped key, 409 for one another
 * account already claimed).
 */
export const onboardKey = (
  fetch: TestFetch,
  bearer: string,
  apiKey = "users-own-key",
): Promise<Response> =>
  authFetch(fetch, "/studio/account/key", { method: "PUT", key: bearer, body: { apiKey } });
