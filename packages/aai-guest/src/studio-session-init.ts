// Copyright 2026 the AAI authors. MIT license.
/**
 * Installing a studio coding-agent session over HTTP, as an alternative to
 * the `studio/session-init` control-channel request.
 *
 * WHY BOTH. A harness accepts exactly ONE host control connection (a second
 * authenticated `/ws` dial is refused 409 — two hosts would interleave their
 * RPC streams), so the replica that spawned this sandbox owns the socket for
 * the sandbox's life. But the platform's web service AUTOSCALES, and Modal
 * routes every request independently: the broker call that needs to refresh
 * this session routinely lands on a DIFFERENT replica than the one holding
 * the socket. With the RPC as the only way in, that replica could not install
 * a session at all, so it spawned a second sandbox for the same project — a
 * duplicate guest, billed, and a second writer racing the first on the same
 * workspace row.
 *
 * The split that fixes it: the SOCKET stays the owner's, carrying lifecycle
 * and the guest→host RPCs (`studio/sync-workspace`, `studio/persist-chat`);
 * this HTTP route lets ANY replica (re)install the session, which is all a
 * cold broker call actually needs. Both paths funnel into the same
 * `initStudioSession`, so there is one notion of what a session is.
 *
 * Gated by the per-sandbox HOST token (`AAI_GUEST_TOKEN`) — the same bearer
 * that gates `/ws` and `/manage/*` — NOT the per-session `chatToken`. The
 * caller here is a platform replica, not a browser: the chat token is the
 * credential this route MINTS AND RETURNS, so accepting it as the gate would
 * be circular, and the tunnel URL is public.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { errorMessage } from "@alexkroman1/aai";
import { formatSchemaIssues } from "@alexkroman1/aai/internal";
import { z } from "zod";
import { verifyBearer } from "./harness-auth.ts";
import type { HarnessState } from "./harness-bundle.ts";
import { CORS_HEADERS, readBody, sendJson } from "./studio-http.ts";
import { initStudioSession, SessionIdentityError } from "./studio-session.ts";

/** The route this module claims. Mirrors `GUEST_ROUTES.studioSessionInit`. */
export const SESSION_INIT_PATH = "/studio/session-init";

/**
 * Cap on the install body. A session install carries the whole workspace, so
 * it is sized off the workspace caps (`MAX_STUDIO_FILES` ×
 * `MAX_STUDIO_FILE_BYTES`) with headroom for JSON overhead, rather than the
 * chat surface's conversation budget.
 */
const MAX_INIT_BODY_BYTES = 32_000_000;

/** Mirrors `StudioSessionParams` (studio-session.ts) field for field. */
export const SessionInitParamsSchema = z.object({
  scope: z.string(),
  project: z.string(),
  files: z.record(z.string(), z.string()),
  apiKey: z.string(),
  chatToken: z.string().min(1),
  system: z.string(),
  model: z.string(),
  region: z.literal("eu").optional(),
  // Reaches `stepCountIs()` in studio-chat.ts — must be a positive integer.
  maxSteps: z.number().int().positive(),
});

/**
 * The harness's HTTP hook for `POST /studio/session-init` — returns true when
 * the request was claimed. Wired into `createServer`'s `request` option ahead
 * of the public chat surface.
 *
 * Installing REPLACES any session already loaded, which is the same semantics
 * the RPC has: repeat installs reset the workspace to the store's current
 * files so a fresh page never sees a stale tree.
 */
export function handleSessionInitRequest(
  state: HarnessState,
  hostToken: string,
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  method: string,
): boolean {
  if (url !== SESSION_INIT_PATH) return false;
  if (method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return true;
  }
  if (method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return true;
  }
  if (!verifyBearer(req.headers.authorization, hostToken)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return true;
  }
  void install(state, req, res);
  return true;
}

async function install(
  state: HarnessState,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const parsed = SessionInitParamsSchema.safeParse(
      JSON.parse(await readBody(req, MAX_INIT_BODY_BYTES)),
    );
    if (!parsed.success) {
      sendJson(res, 400, {
        error: `Invalid session-init: ${formatSchemaIssues(parsed.error.issues)}`,
      });
      return;
    }
    state.studio = await initStudioSession(parsed.data);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    const error = errorMessage(err);
    // A mismatched identity is the caller addressing the wrong sandbox, not a
    // guest fault — 409 so the broker drops its registry row and cold-spawns
    // instead of retrying against a guest that will never accept it.
    const status = err instanceof SessionIdentityError ? 409 : 500;
    console.error(`studio session-init failed: ${error}`);
    if (!res.headersSent) sendJson(res, status, { error });
    else res.destroy();
  }
}
