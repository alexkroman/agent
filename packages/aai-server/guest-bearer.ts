// Copyright 2026 the AAI authors. MIT license.
/**
 * The bearer check every GUEST-CALLED route on `/:slug` shares.
 *
 * Four identical copies of this function existed — in the session-state, enqueue,
 * run-storage and run-stream handlers — byte for byte, and a fifth was about to be
 * written for uploads. That is the shape this repo's guide calls a missing typed
 * seam: not a cast, but the same reasoning restated until one copy drifts.
 *
 * ## What it decides, and why each answer is the status it is
 *
 * The token is `HMAC(secret, agentSandboxName(slug, version))` — deterministic
 * across replicas, so any replica can verify a bearer minted by whichever one
 * spawned the guest, with no shared state (`guest-token.ts`).
 *
 * - **No header, or an empty one → 401.** Not 400: the caller supplied no
 *   credential, which is the ordinary unauthenticated case.
 * - **No such agent → 503, not 404.** The version read is what mints the expected
 *   token, so a missing row means this route cannot form an answer — and a 404
 *   would tell an unauthenticated caller whether a slug exists, which every other
 *   route on this surface refuses to do.
 * - **A mismatch → 401, compared in CONSTANT TIME.** `constantTimeEquals`, because
 *   an early-exit compare on a 64-hex HMAC leaks it a nibble at a time to a caller
 *   who can time the reply, and these routes are reachable from the tunnel.
 *
 * ## Why it takes the Context rather than the token
 *
 * The alternative — a caller extracting the header and passing a string — puts the
 * "did you remember to strip `Bearer `" step at five call sites. The whole point is
 * that a route asks one question and gets the whole policy. The strip itself is
 * `parseBearer`, shared with `middleware.ts`: it answers `""` for a header that is
 * not a Bearer credential, where a `.replace(/^Bearer /, "")` would hand the raw
 * header on as if it were the token.
 *
 * @internal
 */

import { HTTPException } from "hono/http-exception";
import { parseBearer } from "./_bearer.ts";
import { constantTimeEquals } from "./_timing-safe.ts";
import type { AppContext } from "./context.ts";
import { guestTokenFor } from "./guest-token.ts";
import { agentSandboxName } from "./sandbox-directory.ts";

/**
 * Throw unless this request carries the bearer `slug`'s running guest would hold.
 *
 * @internal
 */
export async function assertGuestBearer(c: AppContext, slug: string): Promise<void> {
  const supplied = parseBearer(c.req.header("authorization"));
  if (supplied === "") {
    throw new HTTPException(401, { message: "unauthorized" });
  }
  const version = await c.env.store.getAgentVersion(slug);
  if (version === null) throw new HTTPException(503, { message: "agent unavailable" });
  if (!constantTimeEquals(supplied, guestTokenFor(agentSandboxName(slug, version)))) {
    throw new HTTPException(401, { message: "unauthorized" });
  }
}
