// Copyright 2026 the AAI authors. MIT license.
/**
 * The host-side bearer gate's three parts, on `/host-internal`: the parse
 * (`parseBearer`, declared in `sdk/parse-bearer.ts` so `apiKeyRoute` shares it,
 * re-exported here), the one thing its return type obliges every caller to
 * check ({@link isBlankSecret}), and the Node constant-time compare
 * ({@link constantTimeEquals}).
 *
 * `aai-server`'s copy of the parse was fixed first and could not be shared:
 * neither the guest harness nor the workflow API may import that package. This
 * is the "one layer down" its module doc points at — the harness holds no copy
 * of `aai-runtime` (it drives the agent through the runtime its bundle carries),
 * so a helper it calls on its own must come from the SDK.
 *
 * @module bearer
 */

import { timingSafeEqual } from "node:crypto";

export { parseBearer } from "../sdk/parse-bearer.ts";

/**
 * Is `secret` a value no caller can ever legitimately PRESENT?
 *
 * This exists because of {@link parseBearer}'s codomain, which is why it lives
 * here rather than at either gate. That function maps three different requests —
 * no header at all, a header that is not a Bearer credential, and a Bearer
 * credential whose token68 is empty — onto the same `""`. So `""` on the
 * PRESENTED side never means "the caller presented the empty token"; it means
 * "there was no token". An expected secret of `""` is therefore not a credential
 * a caller can satisfy, only one a caller who presented NOTHING accidentally
 * equals.
 *
 * **And it did.** `AAI_WORKFLOW_API_TOKEN=` or `AAI_SESSION_EVENTS_TOKEN=` — set
 * but empty, which `SecretUpdatesSchema` (`z.record(SecretKeySchema, z.string())`)
 * accepts from the studio's Secrets pane — made `timingSafeEqual` compare two
 * empty buffers, which MATCH. Both gates guarded `token === undefined` and
 * neither guarded `token === ""`, so a variable whose whole purpose is to require
 * a credential turned authentication OFF: measured, `GET /session-events/:id`
 * answered 200 with the conversation to a request carrying no `Authorization`
 * header at all.
 *
 * Whitespace-only counts as blank for the same reason and no further one:
 * `parseBearer` TRIMS, so `"   "` is likewise not in its codomain — a
 * whitespace-only secret is a secret nothing can present, i.e. no secret. The
 * line stops there deliberately. A merely PADDED secret (`" x "`) is also
 * unpresentable, and is NOT reported blank, because the callers below act on this
 * answer by falling back to their default posture — and for the workflow API that
 * default is OPEN, so widening this predicate past "no secret at all" would let a
 * typo open a surface instead of closing it.
 */
export function isBlankSecret(secret: string | null | undefined): boolean {
  return secret === null || secret === undefined || secret.trim() === "";
}

/**
 * True when `a` and `b` are equal, without a data-dependent early exit — the
 * one constant-time string comparison every host-side gate shares.
 *
 * `node:crypto`'s `timingSafeEqual` THROWS on a length mismatch, so the lengths
 * are compared first. That leaks only the length of a value the CALLER chose,
 * never anything about the expected one.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf-8");
  const right = Buffer.from(b, "utf-8");
  return left.length === right.length && timingSafeEqual(left, right);
}
