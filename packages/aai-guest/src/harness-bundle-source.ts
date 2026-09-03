// Copyright 2026 the AAI authors. MIT license.
/**
 * How a bundle REACHES a guest, for every mode that receives one.
 *
 * A spawner delivers the worker bundle one of two ways and picks by naming
 * one env var or the other — a file it wrote into the sandbox before exec, or
 * a time-boxed signed Storage URL the guest fetches ITSELF (which keeps ~8 MB
 * from crossing the platform twice). The two shapes are mutually exclusive on
 * the wire on purpose: there is no precedence rule for either side to get
 * wrong, and no way to point a guest at a path nobody wrote.
 *
 * The URL shape is safe for exactly one reason — the HASH. The guest verifies
 * the bytes against a sha-256 the spawner names, so it trusts the hash and
 * never the transport, the URL, or whoever served it. The hash is therefore
 * REQUIRED, for both shapes: "a bundle is never loaded unverified" holds by
 * type rather than by each caller remembering to check.
 *
 * The env var NAMES belong to the mode, so the caller passes values rather
 * than reading `process.env` here.
 */

import { hash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { errorMessage } from "@alexkroman1/aai/utils";
import { BUNDLE_FETCH_TIMEOUT_MS } from "./limits.ts";

/** Where the spawner said the bundle is. */
export type BundleSource = { url: string } | { path: string };

/**
 * The delivery shape the spawner chose, or null when it named neither.
 * URL wins if both are somehow set — but spawners never set both, and the
 * caller's own "neither" error is the one that names the mode's env vars.
 */
export function bundleSourceOf(
  url: string | undefined,
  path: string | undefined,
): BundleSource | null {
  if (url) return { url };
  return path ? { path } : null;
}

/**
 * Read a bundle from either delivery shape and verify it against `expected`
 * (sha-256 hex).
 */
export async function readVerifiedBundle(source: BundleSource, expected: string): Promise<string> {
  const code =
    "url" in source ? await fetchBundle(source.url) : await readFile(source.path, "utf-8");
  const actual = hash("sha256", code);
  if (actual !== expected.toLowerCase()) {
    throw new Error(
      `bundle hash mismatch: expected sha256 ${expected}, got ${actual} — refusing to load`,
    );
  }
  return code;
}

/**
 * Fetch the worker bundle from the signed URL the spawner handed us.
 *
 * Two things it deliberately does not do. It does not RETRY: the caller of a
 * failed boot is the platform's spawn path, which fails the spawn and lets
 * the client re-broker onto a fresh sandbox — a retry loop here would only
 * make a dead URL take longer to report. And it never puts the URL in an
 * error: the URL *is* the read capability for this blob, and a boot failure's
 * whole job is to be printed to stderr and shipped to the host log
 * (`startGuestLogging`). The status and the byte count are what diagnose it.
 */
async function fetchBundle(url: string): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(BUNDLE_FETCH_TIMEOUT_MS),
  }).catch((err: unknown) => {
    throw new Error(`bundle fetch failed: ${errorMessage(err)}`);
  });
  if (!res.ok) {
    // A 400 here is very likely an EXPIRED signature rather than a bad
    // request, since the URL was minted seconds ago by the spawner; say so,
    // because the alternative reading sends a reader looking for a bug in the
    // request this code does not build.
    throw new Error(
      `bundle fetch rejected with HTTP ${res.status} (an expired signed URL looks like this)`,
    );
  }
  return await res.text();
}
