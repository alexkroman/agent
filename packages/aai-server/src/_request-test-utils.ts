// Copyright 2025 the AAI authors. MIT license.

/**
 * Building a platform request in a spec: auth headers, the standard deploy
 * payload, and the guest-side bearer. Never a header literal — see "Building a
 * platform request in a test" in `packages/aai-server/CLAUDE.md`.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import { type TestFetch, VALID_ENV } from "./_orchestrator-test-utils.ts";
import { guestTokenFor } from "./guest/token.ts";
import { agentSandboxName } from "./sandbox/directory.ts";

/** The default deploy payload as an OBJECT: `deployBody`'s and `deploy`'s source. */
function deployPayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    env: VALID_ENV,
    worker:
      'export default { name: "test-agent", systemPrompt: "Test", greeting: "", maxSteps: 1, tools: {} };',
    clientFiles: {
      // Built from its tags rather than one literal: at full length biome's
      // `noSecrets` entropy heuristic scores the markup as a credential.
      "index.html": [
        "<!DOCTYPE html><html><body>",
        '<script type="module" src="./assets/index.js"></script>',
        "</body></html>",
      ].join(""),
      "assets/index.js": 'console.log("c");',
    },
    ...overrides,
  };
}

export function deployBody(overrides?: Record<string, unknown>): string {
  return JSON.stringify(deployPayload(overrides));
}

/** Standard auth + JSON headers for test requests. */
export function authHeaders(key = "key1"): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

/** Convenience: authenticated JSON request via test fetch. */
export async function authFetch(
  fetch: TestFetch,
  path: string,
  opts: { method?: string; key?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(path, {
    method: opts.method ?? "POST",
    headers: authHeaders(opts.key),
    ...omitUndefined({ body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }),
  });
}

/**
 * Authenticated `POST /deploy` carrying the standard test body. Use
 * {@link deployAgent} when the response does not matter, and a bare `fetch`
 * only when the REQUEST itself is the subject (a missing header, a gzipped
 * body, a raw string).
 */
export async function deploy(
  fetch: TestFetch,
  opts: { key?: string; body?: Record<string, unknown> } = {},
): Promise<Response> {
  return authFetch(fetch, "/deploy", { ...opts, body: deployPayload(opts.body) });
}

/**
 * Deploy one agent as SETUP, failing loudly ("deploy mine answered 401") when
 * it does not land, rather than as whatever the test makes of a missing slug.
 */
export async function deployAgent(
  fetch: TestFetch,
  slug = "my-agent",
  key = "key1",
): Promise<void> {
  const res = await deploy(fetch, { key, body: { slug } });
  if (!res.ok) throw new Error(`deploy ${slug} answered ${res.status}`);
}

/**
 * The bearer `slug`'s running guest would present — the GUEST-side counterpart
 * of {@link authHeaders} (`HMAC(secret, agentSandboxName(slug, version))`, see
 * `guest/bearer.ts`). A missing agent falls back to version 1, for the 401/503
 * cases.
 */
export async function bearerFor(
  store: { getAgentVersion(slug: string): Promise<number | null> },
  slug: string,
): Promise<string> {
  const version = (await store.getAgentVersion(slug)) ?? 1;
  return guestTokenFor(agentSandboxName(slug, version));
}

/** One request the platform forwarded to a {@link recordingGuest}. */
export type GuestCall = {
  url: string;
  method: string;
  headers: Headers;
  /** The body as UTF-8 text. */
  body: string;
  /** The body's exact bytes. */
  bytes: Buffer;
  /** The `init` the platform passed, as handed over (`{}` when absent). */
  init: RequestInit;
};

/**
 * A guest `fetchFn` that records what the platform forwarded and answers as
 * the guest would (`answer` defaults to a 200 `{}`).
 */
export function recordingGuest(
  answer: (req: Request) => Response | Promise<Response> = () =>
    new Response("{}", { status: 200 }),
): { calls: GuestCall[]; fetchFn: typeof globalThis.fetch } {
  const calls: GuestCall[] = [];
  const fetchFn: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    const bytes = Buffer.from(await req.clone().arrayBuffer());
    calls.push({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: bytes.toString("utf8"),
      bytes,
      init: init ?? {},
    });
    return await answer(req);
  };
  return { calls, fetchFn };
}
