// Copyright 2026 the AAI authors. MIT license.
/**
 * A W3C trace context for one platform RPC, so the two sides of the hop can be
 * JOINED.
 *
 * ## The number that had no breakdown
 *
 * The busiest guest→platform call is the journal RPC, measured at ~840 ms of
 * server time (`packages/aai-runtime/CLAUDE.md`, "A journal read is a round
 * trip"), and until now that was a total. `withReserved` in `aai-server` splits
 * the SERVER's half of it — how long the admin reservation waited, how long the
 * statement ran — which answers "was it our pool" and leaves the rest of the
 * wall clock unaccounted: the proxy, the round trip, and anything queued before
 * the handler ran.
 *
 * Both halves are now measured. What was missing is the ability to put one
 * beside the other: a busy replica writes hundreds of these a second, so a
 * timestamp cannot correlate a caller's line with the handler's. An id can.
 *
 *   guest   `platform call { label: 'journal', traceId: 'a1b2…', elapsedMs: 863 }`
 *   server  `Platform admin reservation { traceId: 'a1b2…', waitedMs: 2 }`
 *   server  `… { traceId: 'a1b2…', waitedMs: 2, workMs: 41 }`
 *
 * 863 against 43 says the pool was never the constraint and the remaining
 * ~820 ms is the hop. That is a conclusion neither side could reach alone.
 *
 * ## Why W3C rather than a header of our own
 *
 * `traceparent` is the format every tracing backend already parses, so an
 * operator who later puts an OTEL collector in front of this gets these spans
 * for free rather than having to teach it a private header. It costs nothing to
 * emit correctly — 55 fixed characters — and a private `x-aai-trace-id` would
 * have to be translated by whatever reads it.
 *
 * ## One span per CALL, and what that does not buy
 *
 * {@link newTraceparent} mints a fresh trace id per RPC. So all of one
 * delivery's journal calls are NOT tied together, and a run's whole walk is not
 * one trace — which is the more useful thing and needs more than a header: the
 * trace would have to be minted where the delivery arrives and carried through
 * the run context (`workflow-run-context.ts`) so every step's calls inherit it.
 * That is worth doing and is deliberately not done here; a per-call span is what
 * the question above actually needs, and it is the half that cannot be wrong.
 *
 * `sampled` is always set. There is no sampler and nothing downstream reads the
 * flag yet, so claiming a decision we did not make would be the lie; `01` says
 * "record this", which is what both sides then do.
 *
 * @internal
 */

import { randomBytes } from "node:crypto";

/**
 * The one grammar, so the minter and the parser cannot disagree.
 *
 * Anchored, lower-case hex only, and the four fields exactly as long as the spec
 * says. `00` is pinned as the version because that is the only version defined —
 * the spec's forward-compatibility rule says to accept a higher one and parse
 * the first two fields anyway, which is a rule worth following the day a version
 * `01` exists and not before: accepting one now would mean accepting a shape
 * nothing can emit.
 */
const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

/** An all-zero id, which the spec makes invalid for both fields. */
const isZero = (hex: string): boolean => /^0+$/.test(hex);

/**
 * A fresh `traceparent` for one outbound call.
 *
 * @internal
 */
export function newTraceparent(): string {
  return `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
}

/**
 * The three fields of a `traceparent` a reader can act on.
 *
 * @internal
 */
export type TraceParent = {
  /** 32 lower-case hex characters, never all zero. */
  traceId: string;
  /** 16 lower-case hex characters, never all zero — the CALLER's own span. */
  spanId: string;
  /** The trace-flags byte; `0x01` is "sampled". */
  flags: number;
};

/**
 * A `traceparent`, parsed — or `undefined` when the header is not one.
 *
 * REFUSES rather than repairs, and the refusals matter more than the successes:
 * this value is a log field, so a malformed header that parsed to something
 * plausible would put a junk id beside real ones and make a search for it answer
 * lines from unrelated requests. An absent header is the ordinary case — an
 * older guest, or any other caller — and is not a failure.
 *
 * ## ONE parser, because a second one is a second ANSWER
 *
 * `aai-server` now turns this same header into an exported OTLP span as well as
 * into a log field (`tracing-propagator.ts`), and the whole value of doing that
 * is that the id in the log line and the id on the span are the same id — an
 * operator pivots from one to the other. Two parsers of one header can disagree,
 * and the disagreements here are concrete rather than theoretical: this grammar
 * pins version `00` and rejects both all-zero ids, where a library parser
 * following the spec's forward-compatibility rule accepts a higher version. On a
 * header the two read differently, the log line and the span would carry
 * DIFFERENT trace ids — which is worse than carrying none, because it is
 * silently wrong rather than absent. So the server's propagator is built on this
 * function rather than beside it.
 *
 * @internal
 */
export function parseTraceparent(header: string | null | undefined): TraceParent | undefined {
  const raw = header ?? "";
  const match = TRACEPARENT_RE.exec(raw);
  if (!match) return undefined;
  const [, traceId, spanId] = match;
  if (traceId === undefined || spanId === undefined) return undefined;
  // Both all-zero ids are invalid per the spec, and a caller that sends one is
  // saying "I have no trace" in the most confusing way available.
  if (isZero(traceId) || isZero(spanId)) return undefined;
  // The last two characters are the flags byte, and the grammar above already
  // proved they are hex — so this cannot be `NaN`.
  return { traceId, spanId, flags: Number.parseInt(raw.slice(-2), 16) };
}

/**
 * The trace id inside a `traceparent`, or `undefined` when there is not one.
 *
 * The log-field half of {@link parseTraceparent}, and the caller that has always
 * existed: every line `withReserved` writes carries this.
 *
 * @internal
 */
export function traceIdOf(header: string | null | undefined): string | undefined {
  return parseTraceparent(header)?.traceId;
}
