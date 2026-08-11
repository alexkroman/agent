// Copyright 2026 the AAI authors. MIT license.
/**
 * `POST /analytics/ingest` — where a deployed agent's guest ships the session
 * analytics its runtime recorded.
 *
 * This is the only route on the platform written by an untrusted guest rather
 * than by a user, so its posture is different from every other one:
 *
 * - **The token authorizes one slug** (analytics-token.ts) and the route
 *   verifies it against the slug IN THE BODY. A guest cannot write rows
 *   attributed to an agent it is not.
 * - **The batch is capped** ({@link MAX_BATCH_ROWS}) and every field is
 *   length-clamped by the schema, so one sandbox cannot turn the platform's
 *   largest table into its own disk quota. The runtime clamps too — this is
 *   the boundary that does not trust it.
 * - **It answers 202, and it means it.** A rejected batch must not make a
 *   guest retry forever, and a stored batch is not worth a round trip of
 *   detail: the guest drops what it shipped either way (see the shipper's
 *   at-most-once note). Only a 401 is worth distinguishing, because that one
 *   means "your token is wrong", which retrying will never fix.
 */

import { errorMessage } from "@alexkroman1/aai";
import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { parseBearer } from "./_bearer.ts";
import type { AnalyticsRow } from "./analytics-store.ts";
import { verifyAnalyticsToken } from "./analytics-token.ts";
import type { HonoEnv } from "./context.ts";
import { SLUG_PATTERN_SOURCE } from "./schemas.ts";

/**
 * One shipment's row cap. Sized well above the shipper's own flush threshold
 * so a normal batch never trips it, and far below anything that would make a
 * single insert expensive.
 */
export const MAX_BATCH_ROWS = 500;

const MAX_TEXT = 4000;

/**
 * Serialized cap on one event's `data` object.
 *
 * It was `z.record(z.string(), z.unknown())` with no bound at all, which is
 * the one field in this schema that could carry an arbitrary amount: every
 * other one is a `.max()`-ed string or a number. The runtime clamps each
 * VALUE to 1000 characters, and this is the boundary that does not trust it —
 * nothing stops a guest sending ten thousand keys of a thousand characters.
 */
const MAX_DATA_CHARS = 4000;

/**
 * Wire cap on one shipment, DERIVED from what the schema already permits
 * rather than picked: the largest legal batch is {@link MAX_BATCH_ROWS} rows
 * each carrying a `text`, a `data`, and the small fixed fields, so anything
 * past this is a body the validator was always going to reject.
 *
 * Deriving it is what keeps it honest — a hand-chosen number silently becomes
 * the real row cap the day someone raises {@link MAX_BATCH_ROWS}.
 */
export const MAX_INGEST_BODY_BYTES = MAX_BATCH_ROWS * (MAX_TEXT + MAX_DATA_CHARS + 1024);

/**
 * The wire shape, kept deliberately close to the column list: this is the
 * boundary where a guest's claim becomes a platform row, and a field that
 * needs translating is a field that can be translated wrongly.
 *
 * `kind` is a bare string rather than an enum of the runtime's current kinds —
 * a guest runs a harness image pinned at ITS deploy, so a new kind shipped by
 * an older-or-newer runtime must land as data rather than 400 the whole batch.
 * The readers all filter by the kinds they know.
 */
const EventSchema = z.object({
  sessionId: z.string().min(1).max(200),
  ts: z.number().int().positive(),
  kind: z.string().min(1).max(40),
  turn: z.number().int().min(0).max(100_000).default(0),
  durationMs: z.number().int().min(0).max(86_400_000).optional(),
  level: z.string().max(20).optional(),
  name: z.string().max(200).optional(),
  text: z.string().max(MAX_TEXT).optional(),
  ok: z.boolean().optional(),
  data: z
    .record(z.string(), z.unknown())
    .refine((value) => JSON.stringify(value).length <= MAX_DATA_CHARS, {
      message: `data must serialize to at most ${MAX_DATA_CHARS} characters`,
    })
    .optional(),
});

const IngestBodySchema = z.object({
  slug: z.string().regex(new RegExp(`^${SLUG_PATTERN_SOURCE}$`)),
  agentVersion: z.number().int().nonnegative().optional(),
  events: z.array(EventSchema).min(1).max(MAX_BATCH_ROWS),
});

export type AnalyticsIngestBody = z.infer<typeof IngestBodySchema>;

/** Register the ingest route. No-op wiring is impossible — see the 404 below. */
export function registerAnalyticsIngest(app: Hono<HonoEnv>): void {
  app.post(
    "/analytics/ingest",
    // FIRST, ahead of the validator, and declared HERE rather than in
    // orchestrator.ts so the route carries its own bound.
    //
    // The token cannot be checked any earlier than it is: it authorizes one
    // slug and the slug is in the BODY, so verifying it means parsing first.
    // That ordering is fine and the size bound is what makes it fine — without
    // one, an unauthenticated caller chose how much JSON this process would
    // parse. (The only other body-limited route, `/deploy`, is limited in
    // orchestrator.ts because it needs the gzip middleware around it too.)
    bodyLimit({
      maxSize: MAX_INGEST_BODY_BYTES,
      onError: (c) => c.json({ error: "Batch too large" }, 413),
    }),
    zValidator("json", IngestBodySchema),
    async (c) => {
      const analytics = c.env.analytics;
      // No binding, or a read-only one (the studio service is handed the store
      // without the ingest secret): the feature is off for THIS app. A 404
      // rather than a 500 — the guest treats it as "stop shipping", which is
      // exactly right, and a deployment with no platform database is not broken.
      const ingestSecret = analytics?.ingestSecret;
      if (!(analytics && ingestSecret)) return c.json({ error: "Analytics is not enabled" }, 404);

      const body = c.req.valid("json");
      const token = parseBearer(c.req.raw.headers.get("authorization"));
      // Verified against the slug the BODY claims, which is what binds the
      // capability to one agent. Reading the slug from the token instead would
      // be the same check written the wrong way round.
      if (!(token && verifyAnalyticsToken(ingestSecret, body.slug, token))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const rows: AnalyticsRow[] = body.events.map((event) => ({
        slug: body.slug,
        agentVersion: body.agentVersion,
        sessionId: event.sessionId,
        ts: event.ts,
        kind: event.kind,
        turn: event.turn,
        durationMs: event.durationMs,
        level: event.level,
        name: event.name,
        body: event.text,
        ok: event.ok,
        data: event.data,
      }));

      try {
        await analytics.store.append(rows);
      } catch (err) {
        // Logged, not surfaced: the guest cannot act on a storage failure and
        // must not stall a session retrying one.
        console.warn("analytics ingest failed", {
          slug: body.slug,
          rows: rows.length,
          error: errorMessage(err),
        });
        return c.json({ accepted: 0 }, 202);
      }
      return c.json({ accepted: rows.length }, 202);
    },
  );
}
