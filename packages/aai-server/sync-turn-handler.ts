// Copyright 2026 the AAI authors. MIT license.
/**
 * Platform handler for connectionless sync turns (see `host/sync-turn.ts`
 * in the SDK): one complete conversational exchange per HTTP request, no
 * WebSocket on either leg. Shared by the per-agent route
 * (`POST /:slug/sync`) and the studio's project route
 * (`POST /studio/projects/:project/sync`), which resolves its published
 * slug and delegates here.
 *
 * Like the agent's WebSocket, the per-agent route is deliberately
 * unauthenticated — a sync turn is the same capability as a voice session,
 * just connectionless. Status mapping mirrors the self-hosted server:
 * malformed input → 400, `SyncTurnError` → its status (422/409/502),
 * unknown agent → 404.
 */

import { SyncTurnRequestSchema } from "@alexkroman1/aai/protocol";
import { SyncTurnError } from "@alexkroman1/aai/runtime";
import type { AppContext } from "./context.ts";
import { resolveSandbox } from "./sandbox.ts";
import type { SandboxPool } from "./sandbox-pool.ts";

/** Test seam matching {@link resolveSandbox}'s signature. */
export type ResolveSandboxFn = typeof resolveSandbox;

/** Run one sync turn against the deployed agent `slug`. */
export async function handleSyncTurn(
  c: AppContext,
  slug: string,
  pool?: SandboxPool,
  resolve: ResolveSandboxFn = resolveSandbox,
): Promise<Response> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const parsed = SyncTurnRequestSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? "invalid request" }, 400);
  }

  const sandbox = await resolve(slug, {
    slots: c.env.slots,
    store: c.env.store,
    storage: c.env.storage,
    defaultVector: c.env.defaultVector,
    ...(pool && { pool }),
  });
  if (!sandbox) return c.json({ error: "agent not found" }, 404);

  try {
    return c.json(await sandbox.runSyncTurn(parsed.data));
  } catch (err) {
    if (err instanceof SyncTurnError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
