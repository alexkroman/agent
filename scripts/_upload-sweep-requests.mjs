// Copyright 2026 the AAI authors. MIT license.
/**
 * The sweep's BOOKKEEPING: what each request was, how long it took, and where the
 * run's ids are written.
 *
 * Split from `upload-sweep.mjs` for the file-length cap, on the seam it already had
 * — that file decides what to measure and this one records what happened. Its two
 * siblings (`_upload-sweep-args.mjs`, `_upload-sweep-report.mjs`) are the same idea
 * either side of it.
 */

import path from "node:path";

export function installCountingFetch() {
  const real = globalThis.fetch;
  const requests = [];
  const origins = new Set();
  globalThis.fetch = async (input, init) => {
    // A `Request` carries `.url`; a `URL` stringifies to it. `in` rather than
    // optional chaining, which reads as a guard here and is not one.
    const url =
      typeof input === "string" ? input : String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const bytes = bodyBytes(init?.body);
    const kind = classify(method, bytes);
    // How many windows a body-less claim named. That is the whole subject of
    // `UPLOAD_CLAIM_BATCH`, and without it a falling `record` count is
    // indistinguishable from windows going missing.
    const named = kind === "record" ? countOffsets(url) : 0;
    const started = performance.now();
    try {
      const res = await real(input, init);
      requests.push({
        kind,
        method,
        named,
        status: res.status,
        bytes,
        ms: performance.now() - started,
      });
      origins.add(new URL(url).origin);
      return res;
    } catch (err) {
      requests.push({
        kind,
        method,
        named,
        status: 0,
        bytes,
        ms: performance.now() - started,
        err: describeError(err),
      });
      origins.add(new URL(url).origin);
      throw err;
    }
  };
  return {
    requests,
    origins,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

export function defaultJsonPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.resolve(import.meta.dirname, "..", "reports", "upload-sweep", `${stamp}.json`);
}

export function countOffsets(url) {
  try {
    return new URL(url).searchParams.getAll("offset").length;
  } catch {
    return 0;
  }
}

export function classify(method, bytes) {
  if (method === "POST") return "claim";
  if (method !== "PUT") return "info";
  return bytes > 0 ? "bytes" : "record";
}

export function describeError(err) {
  const parts = [];
  for (let at = err, depth = 0; at !== undefined && at !== null && depth < 4; depth += 1) {
    const code = at.code === undefined ? "" : ` (${at.code})`;
    parts.push(`${at.name ?? "Error"}: ${at.message ?? String(at)}${code}`);
    at = at.cause;
  }
  return parts.join(" <- ");
}

export function bodyBytes(body) {
  if (body === undefined || body === null) return 0;
  if (typeof body === "string") return Buffer.byteLength(body);
  if (typeof body.size === "number") return body.size;
  if (typeof body.byteLength === "number") return body.byteLength;
  return 0;
}
