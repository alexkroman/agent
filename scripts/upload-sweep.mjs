#!/usr/bin/env node

/**
 * Measure where the parts upload's fan-out stops buying anything.
 *
 * `UPLOAD_PART_CONCURRENCY` (4) and `UPLOAD_PART_BYTES` (8 MiB) are the two
 * numbers a parallel upload is shaped by, and both were ARGUED rather than
 * measured — "the bottleneck moves from per-connection window scaling to the
 * link itself somewhere around four" is a belief, and a reader cannot falsify
 * it. Every other fan-out width in this repo carries a table with its corpus
 * named: `MAX_SEGMENT_CONCURRENCY` (32, the measured knee over 65 segments of
 * 1h37m audio) and `stepFetch`'s transport comparison. This is how those two
 * get one.
 *
 * It matters more than it did, because the topology moved underneath the
 * number. A part used to be a request writing chunk ROWS through the guest for
 * as long as it lasted, which is half of why 4 was chosen ("multiplying the
 * writes the agent is doing at once"); a part is now one small `update` naming a
 * window that landed, which is why `UPLOAD_DB_POOL` came back DOWN to 2. The
 * client end of that same argument never moved.
 *
 * ## Not a gate, and it cannot become one
 *
 * Same rule as `check:gateway-models`: it spends real bandwidth against a live
 * remote, so a bad link would redden unrelated pull requests. Nothing runs it
 * but a person. It also LEAVES ITS UPLOADS BEHIND — there is no delete route on
 * `/workflows/uploads` — so it prints the bytes it is about to store, refuses a
 * large run without `--yes`, and writes every id it minted into `--json` so a
 * cleanup is possible later.
 *
 * ## What it measures, and the one thing it cannot
 *
 * It drives the real `createWorkflowApiClient(...).upload()` — the published
 * path, including the retry budget, the claim, and the `stored=1` record — and
 * counts every request through a wrapped `fetch`. So the report separates the
 * two questions `partBytes x concurrency` confuses: WALL time (did widening the
 * fan-out help) and per-part LATENCY (is the concurrency bound binding, or is
 * the far side). Eight parts each taking 4s means the fan-out is the
 * constraint; eight taking 32s means it is not.
 *
 * **It runs on Node's `fetch`, which is not a browser**, and the difference is
 * exactly where the second half of the current argument lives. Node's undici
 * opens as many connections per origin as it needs; a browser caps HTTP/1.1 at
 * six, which is the stated reason 4 "leaves room for the page to poll the run
 * it just started". So a knee found here is a knee for a programmatic caller,
 * and a browser number needs a browser. `--h2` is the closest available probe:
 * it makes undici negotiate HTTP/2, where the per-origin connection limit stops
 * applying and a capacity limit arrives as a STREAM RESET carrying no HTTP
 * status — invisible to the `Retry-After` handling in `_upload-retry.ts`, and
 * the failure `sdk/step-fetch.ts` pins HTTP/1.1 to avoid. A browser cannot pin
 * it. If the h2 arm shows resets where the h1 arm shows 503s, that is a finding
 * about the browser default and not about this script.
 *
 * ## Reading the output
 *
 * Repeat every cell (`--repeat`, default 3) and read the RANGE, never one
 * actual: these distributions have long left tails, and a single run is not
 * evidence about the unlucky one. Cells run in shuffled order by default so a
 * link that degrades during the sweep does not bias one width.
 *
 * ```sh
 * # against a local dev server, small and cheap, to check the harness works
 * node scripts/upload-sweep.mjs --target http://127.0.0.1:8080 --mib 16
 *
 * # the real question, against a deployed agent over a real link
 * node scripts/upload-sweep.mjs \
 *   --target https://agents.example/my-agent --token "$AAI_WORKFLOW_API_TOKEN" \
 *   --mib 64 --concurrency 1,2,4,8,16 --part-mib 4,8,16 --repeat 5 \
 *   --json /tmp/upload-sweep.json --yes
 *
 * # the same matrix over HTTP/2, which is what a browser would negotiate
 * node scripts/upload-sweep.mjs --target … --h2 --yes
 * ```
 */

import { randomFillSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { sleep } from "../packages/aai/src/sdk/sleep.ts";
import {
  UPLOAD_PART_BYTES,
  UPLOAD_PART_CONCURRENCY,
} from "../packages/aai/src/sdk/upload-constants.ts";
import { createWorkflowApiClient } from "../packages/aai/src/sdk/workflow-api-client.ts";
import { parseSweepArgs, usage } from "./_upload-sweep-args.mjs";
import {
  fixed,
  mbPerSecond,
  median,
  percentile,
  reportKnee,
  reportTable,
} from "./_upload-sweep-report.mjs";
import { defaultJsonPath, describeError, installCountingFetch } from "./_upload-sweep-requests.mjs";

const MIB = 1024 * 1024;

/**
 * Bytes a run may store before it needs `--yes`.
 *
 * The uploads are permanent (no delete route), and on the platform they are
 * objects somebody pays for — so the default matrix has to be one a person can
 * run without thinking, and anything past this has to be chosen.
 */
const UNATTENDED_BYTES_LIMIT = 2 * 1024 * MIB;

/**
 * Discarded uploads a cold target may lose before the sweep gives up.
 *
 * Three, because the thing being waited out is one sandbox spawn and not a queue:
 * a platform agent answers its first request in ~12s or drops it, and a target
 * that has failed three of these is not merely asleep.
 */
const WARMUP_ATTEMPTS = 3;

const args = parseSweepArgs();

const numbers = (value, fallback) =>
  value === undefined
    ? fallback
    : value
        .split(",")
        .map((part) => Number(part.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);

const target = args.target;
if (target === undefined) {
  console.error("upload-sweep: --target is required.");
  usage();
  process.exit(2);
}

const config = {
  target,
  token: args.token,
  fileBytes: Math.round(Number(args.mib ?? 32) * MIB),
  widths: numbers(args.concurrency, [1, 2, 4, 8, 16]),
  partMib: numbers(args["part-mib"], [UPLOAD_PART_BYTES / MIB]),
  repeat: Number(args.repeat ?? 3),
  // 30s, not 1s: the far side's limiter penalises a connection for a while after
  // it trips, so a short gap measures the previous cell as much as this one — see
  // `transport()`. Lower it only for a target with no such limiter.
  gapMs: Number(args["gap-ms"] ?? 30_000),
  json: args.json,
  h2: args.h2,
  shuffle: !args["no-shuffle"],
  warmup: !args["no-warmup"],
  single: !args["no-single"],
  yes: args.yes,
};

/**
 * Every request the SDK issued, classified by SHAPE rather than by URL.
 *
 * Which is what makes one report cover both topologies: on the platform a
 * window's bytes go to a route the platform serves and a bodyless `PUT` tells
 * the agent it landed, under `aai dev` the bytes go to the agent itself. A
 * classifier keyed on the path would need to know which, where "a PUT carrying
 * a body is the bytes" is true of both.
 */
/**
 * What a request IS, from its method and whether it carries bytes.
 *
 * Deliberately not keyed on the path: on the platform a window's bytes go to a
 * route the platform serves and a bodyless `PUT …?stored=1` tells the agent it
 * landed, while under `aai dev` the bytes go to the agent. "A PUT with a body is
 * the bytes" holds in both, so one classifier covers both topologies.
 */
/**
 * Where the run's ids go when `--json` did not say.
 *
 * `reports/` rather than `tmpdir()`: the point is that the ids OUTLIVE the run, and
 * a temp directory is the one place the operating system is entitled to delete. It
 * is gitignored, so nothing here reaches a commit.
 */
/**
 * How many windows one claim named, off its query.
 *
 * A claim may name several (`?offset=&offset=…&stored=1`) when the agent
 * advertised `claimBatch` — see `UPLOAD_CLAIM_BATCH`. Reported so a run against a
 * batching agent is legible: the `record` count drops on purpose, and the number
 * of windows those requests carried is what says so.
 */
/**
 * An error with its CAUSE CHAIN, because the top of one says nothing here.
 *
 * `fetch` reports every transport failure as the same five words —
 * `TypeError: fetch failed` — and puts the fact you need (`ECONNRESET`, a DNS
 * failure, an h2 stream reset, a body that was cut) one or two `cause` hops
 * down. `sdk/step-fetch.ts` documents that exact trap for the fan-out it pins
 * HTTP/1.1 for; a harness whose whole output is a failure column has no excuse
 * for reprinting the useless half.
 */
/**
 * Pin the transport, and hand back a way to start a run on a FRESH connection.
 *
 * Both halves were wrong, and each hid the other. The script printed
 * `transport node fetch, HTTP/1.1` while pinning NOTHING without `--h2` — and
 * undici negotiates h2 with an origin that offers it, so the unflagged arm was
 * h2 wearing an HTTP/1.1 label. Conclusive rather than inferred: that arm failed
 * with `ERR_HTTP2_STREAM_ERROR`, which HTTP/1.1 cannot produce.
 *
 * And the connection has to be NEW per run, because the far side's limiter has a
 * PENALTY WINDOW: once tripped it resets further streams on that connection, so a
 * sweep that reuses one measures its own contamination and every later cell reads
 * worse than the first. That is not a hypothetical — it produced two confident and
 * opposite conclusions in one afternoon, "a hard 2-stream ceiling" and "HTTP/1.1 is
 * 6x faster", both of which evaporated once each cell got a fresh connection and a
 * cooldown. `--shuffle` cannot help: it defends against a link that degrades over
 * the sweep, and this degrades because of what the sweep just did.
 *
 * undici lives in `packages/aai`, not at the root.
 */
async function transport() {
  const requireFromAai = createRequire(new URL("../packages/aai/package.json", import.meta.url));
  const { Agent, setGlobalDispatcher } = await import(requireFromAai.resolve("undici"));
  return {
    /** Install a new dispatcher, so the next request opens its own connection. */
    async fresh() {
      const agent = new Agent({ allowH2: config.h2 });
      setGlobalDispatcher(agent);
      return agent;
    },
  };
}

async function runOnce(api, blob, parallel) {
  const counted = installCountingFetch();
  const started = performance.now();
  let ref;
  let error;
  try {
    ref = await api.upload(blob, {
      name: "upload-sweep.bin",
      type: "application/octet-stream",
      parallel,
    });
  } catch (err) {
    error = describeError(err);
  }
  const ms = performance.now() - started;
  counted.restore();
  const requests = counted.requests;
  const byteRequests = requests.filter((r) => r.kind === "bytes");
  return {
    ms,
    error,
    id: ref?.id,
    origins: [...counted.origins],
    requests: requests.length,
    parts: byteRequests.length,
    claims: requests.filter((r) => r.kind === "record").length,
    claimed: requests.reduce((sum, r) => sum + r.named, 0),
    // The parts path DECLINES rather than failing — a file that fits in one part
    // is the case this sweep can walk into by accident (`--mib 8` against the
    // 8 MiB default part size), and it would then report a single-request row
    // under a fan-out label. A cell that asked for parts and sent none said no.
    //
    // **`error === undefined` is load-bearing, and leaving it out mislabelled a
    // real outage as a benign decline.** A run that dies on its claim also sends
    // zero byte-requests, so the first real-link sweep printed "(declined)" —
    // the word for "this cell was not applicable" — against three cells whose
    // every run had failed with `TypeError: fetch failed` and 66 resets. That is
    // the harness committing the exact sin it exists to catch: reporting a
    // failure in the vocabulary of a non-event.
    declined: parallel !== false && byteRequests.length === 0 && error === undefined,
    partMsP50: median(byteRequests.map((r) => r.ms)),
    partMsP95: percentile(
      byteRequests.map((r) => r.ms),
      95,
    ),
    // A part re-sent is a request beyond the one the plan called for. Counted as
    // an EXCESS rather than from the retry helper's own bookkeeping, which is
    // internal — and this way a claim or an `/info` read that was retried counts
    // too, which is what the branch that added a budget to them cares about.
    failures: requests.filter((r) => r.status === 0 || r.status >= 400).length,
    retryable: requests.filter((r) => r.status === 429 || r.status === 503).length,
    resets: requests.filter((r) => r.status === 0).length,
  };
}

/** Every (width, partBytes) pair, plus the single request the whole path exists to beat. */
function buildCells() {
  const cells = [];
  if (config.single) cells.push({ label: "1 request", parallel: false, width: 1, partMib: 0 });
  for (const partMib of config.partMib) {
    for (const width of config.widths) {
      cells.push({
        label: `${width} x ${partMib} MiB`,
        parallel: { concurrency: width, partBytes: partMib * MIB },
        width,
        partMib,
      });
    }
  }
  return cells;
}

function shuffled(items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Everything printed before a byte moves, plus the refusal. */
function printPlan(cells, totalBytes) {
  const totalMib = Math.round(totalBytes / MIB);
  console.log(`target      ${config.target}`);
  console.log(
    `transport   node fetch, ${config.h2 ? "HTTP/2 (--h2)" : "HTTP/1.1"} (PINNED), fresh connection per run`,
  );
  console.log(`file        ${Math.round(config.fileBytes / MIB)} MiB of random bytes`);
  console.log(`matrix      ${cells.length} cells x ${config.repeat} runs`);
  console.log(
    `defaults    concurrency ${UPLOAD_PART_CONCURRENCY}, part ${UPLOAD_PART_BYTES / MIB} MiB`,
  );
  console.log(`will store  ~${totalMib} MiB, PERMANENTLY — there is no delete route`);

  const tooBig = config.partMib.filter((mib) => mib * MIB >= config.fileBytes);
  if (tooBig.length > 0) {
    console.log(
      `warning     part size(s) ${tooBig.join(", ")} MiB are >= the file, so those cells will DECLINE`,
    );
  }
  if (totalBytes > UNATTENDED_BYTES_LIMIT && !config.yes) {
    console.error(`\nrefusing to store ${totalMib} MiB without --yes.`);
    console.error("lower --mib / --repeat / the matrix, or pass --yes if that is the intent.");
    process.exit(2);
  }
}

/** Random bytes, so nothing on the path can compress the measurement away. */
function makeBody() {
  const buffer = Buffer.allocUnsafe(config.fileBytes);
  for (let offset = 0; offset < buffer.length; offset += 65_536) {
    randomFillSync(buffer, offset, Math.min(65_536, buffer.length - offset));
  }
  return new Blob([buffer]);
}

/**
 * Discarded uploads until one lands, so DNS, TLS and the far side are hot.
 *
 * It FAILS THE RUN when none does, which is the point of doing it first: a target
 * that cannot take one default upload makes every number below meaningless, and a
 * sweep that discovers that in cell seven has already spent the bandwidth.
 *
 * **It takes several attempts, and one was wrong for the target this exists to
 * measure.** A platform agent is a sandbox that self-exits when idle, so the first
 * request after a gap pays a cold spawn — measured at 11.9s for a bare claim — and
 * the connection is sometimes dropped outright rather than answered, which arrives
 * as a bare `TypeError: fetch failed` with no status to read. A single attempt
 * therefore reports the ordinary cold state in the vocabulary of a broken target,
 * and the run that hit it aborted against a deployment that was working.
 */
async function warmup(api, blob) {
  console.log("\nwarmup (discarded): one default upload, retried while the target wakes");
  for (let attempt = 1; attempt <= WARMUP_ATTEMPTS; attempt += 1) {
    const warm = await runOnce(api, blob, undefined);
    if (warm.error === undefined) {
      const shape = warm.parts === 0 ? "declined to one request" : `${warm.parts} parts`;
      console.log(
        `  attempt ${attempt}: ${fixed(warm.ms / 1000, 2)}s, ${shape}, bytes to ${warm.origins.join(", ")}`,
      );
      return;
    }
    console.log(`  attempt ${attempt}/${WARMUP_ATTEMPTS} failed: ${warm.error}`);
    await sleep(config.gapMs);
  }
  console.error("warmup never landed — nothing below would mean anything.");
  process.exit(1);
}

async function main() {
  const cells = buildCells();
  const totalBytes =
    cells.length * config.repeat * config.fileBytes + (config.warmup ? config.fileBytes : 0);

  printPlan(cells, totalBytes);
  const net = await transport();
  await net.fresh();

  const blob = makeBody();
  const api = createWorkflowApiClient({ baseUrl: config.target, token: config.token });
  if (config.warmup) await warmup(api, blob);

  const order = config.shuffle ? shuffled(cells) : cells;
  console.log(`\norder       ${order.map((c) => c.label).join(", ")}`);

  const byLabel = new Map(cells.map((cell) => [cell.label, { ...cell, runs: [] }]));
  for (const cell of order) {
    for (let run = 0; run < config.repeat; run += 1) {
      // A CONNECTION per run — see `transport()`. Closed after the run rather than
      // before the next, so a reset the far side is still penalising cannot ride
      // into the cell that follows.
      const agent = await net.fresh();
      const result = await runOnce(api, blob, cell.parallel);
      await agent.close().catch(() => undefined);
      byLabel.get(cell.label).runs.push(result);
      const note =
        result.error === undefined
          ? `${fixed(result.ms / 1000, 2)}s  ${fixed(mbPerSecond(config.fileBytes, result.ms))} MB/s`
          : `FAILED ${result.error}`;
      console.log(`  ${cell.label.padEnd(16)} run ${run + 1}/${config.repeat}  ${note}`);
      await sleep(config.gapMs);
    }
  }

  const results = cells.map((cell) => byLabel.get(cell.label));
  const rows = reportTable(results, config.fileBytes);
  reportKnee(rows);

  // ALWAYS written, `--json` only chooses where. Every upload this run stored is
  // permanent — there is no delete route, and `aai-sweep-blob-gc` matches
  // `blobs/%`, so nothing reclaims the `uploads/` prefix — which makes the minted
  // ids the only handle a future cleanup could have. Making that conditional on a
  // flag meant the ordinary run (no flag) put a gigabyte somewhere unnameable, and
  // it did: the run that produced the table on `UPLOAD_PART_BYTES` is recoverable
  // only because somebody remembered to pass it.
  const out = config.json ?? defaultJsonPath();
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(
    out,
    `${JSON.stringify({ config: { ...config, token: config.token === undefined ? undefined : "set" }, results }, null, 2)}\n`,
  );
  console.log(`\nwrote ${out} — it carries every upload id this run minted, for cleanup`);
}

await main();
