#!/usr/bin/env node
// The HTTP service a step calls when there is no vendor to call.
//
//   pnpm loadtest:endpoint                                  # 127.0.0.1:4950
//   pnpm loadtest:endpoint --delay=120 --jitter=80          # a slow, uneven far side
//   pnpm loadtest:endpoint --fail-rate=0.2 --retry-after=1  # exercise the retry path
//
// It exists so a fan-out's number is the ENGINE's. A run against a real provider
// measures the provider: `transcription-workflow`'s own concurrency curve came
// out of 17.66 MB uploads where the vendor's queue, not the queue under test,
// decided the shape.
//
// Three knobs, each because a constant far side hides something:
//
//   --delay/--jitter  a fan-out over an EVEN far side is a barrier in disguise;
//                     the window only pays for itself when members settle out of
//                     order, which is also the case `mapConcurrent`'s issue-order
//                     contract is about.
//   --fail-rate       a step that never fails never classifies. A refusal here is
//                     a 503 with `retry-after`, which is what `isTransientStatus`
//                     and `retryAfter` read — the HTTP/1.1 shape, deliberately,
//                     since an h2 stream reset carries no status for either to
//                     see. Pair it with `"classify":true` on the `fanout` input,
//                     or the refusal is a status the step returns and no retry
//                     ever happens.
//   --bytes           a body big enough to cost something to read, for the case
//                     where the payload rather than the round trip is the cost.
//
// Bound to loopback: it answers anything, so it is not a thing to expose.
//
// `node:http` only, so it has no dependencies.

import { createServer } from "node:http";
import { valueReader } from "./_args.mjs";

const arg = valueReader(process.argv.slice(2));

const PORT = Number(arg("port", "4950"));
const DELAY_MS = Number(arg("delay", "0"));
const JITTER_MS = Number(arg("jitter", "0"));
const FAIL_RATE = Number(arg("fail-rate", "0"));
// `String(...)`: a bare `--retry-after` reads as `true` (see `valueReader`),
// and this goes out as a header value.
const RETRY_AFTER = String(arg("retry-after", "1"));
/** The status a refusal answers with — 503 by default, 401 for a FATAL one. */
const FAIL_STATUS = Number(arg("fail-status", "503"));
const BYTES = Number(arg("bytes", "256"));

const BODY = "x".repeat(Math.max(0, BYTES));

const counts = { ok: 0, refused: 0 };

const server = createServer((req, res) => {
  // Deterministic per request index when the caller supplies one, so a rerun of
  // the same fan-out refuses the same members: a retry measurement whose
  // failures move is not a measurement.
  const index = Number(new URL(req.url ?? "/", "http://x").searchParams.get("i") ?? "-1");
  const refuse =
    FAIL_RATE > 0 &&
    (index >= 0 ? (index * 2_654_435_761) % 1000 < FAIL_RATE * 1000 : Math.random() < FAIL_RATE);

  const wait = DELAY_MS + (JITTER_MS > 0 ? Math.floor(Math.random() * JITTER_MS) : 0);
  setTimeout(() => {
    if (refuse) {
      counts.refused += 1;
      // 503 + `retry-after`, which is the pair a step's classification reads.
      // `--fail-status=401` is the other side of that decision: a step should
      // stop on it rather than spend its whole retry budget re-asking.
      res.writeHead(FAIL_STATUS, {
        "content-type": "text/plain",
        "retry-after": RETRY_AFTER,
      });
      res.end("stub endpoint refusing on purpose");
      return;
    }
    counts.ok += 1;
    res.writeHead(200, { "content-type": "text/plain", "content-length": String(BODY.length) });
    res.end(BODY);
  }, wait);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `stub endpoint on http://127.0.0.1:${PORT} ` +
      `(delay=${DELAY_MS}+0..${JITTER_MS}ms fail-rate=${FAIL_RATE} bytes=${BYTES})`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  // Synchronous, so the served count reaches the log before the process goes.
  process.once(signal, () => {
    console.log(`served ${counts.ok} ok, refused ${counts.refused}`);
    server.close(() => process.exit(0));
  });
}
