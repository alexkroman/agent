#!/usr/bin/env node
// What the PLATFORM costs, measured as the difference between two ways of
// reaching the same guest route.
//
//   pnpm loadtest:platform --slug=bench --guest=http://127.0.0.1:4901
//   pnpm loadtest:platform --slug=bench --guest=http://127.0.0.1:4901 --cold=20
//
// A guest route is served twice over: directly by the sandbox, and through the
// platform, which authenticates the caller, resolves the deploy, and proxies. So
// the same request run both ways isolates the server's own overhead from the
// agent's — a single number against the platform cannot, because a slow guest
// and a slow proxy are indistinguishable in it.
//
// `--cold` is the BROKER path and a separate measurement: N requests fired at
// once for a deploy with no live sandbox. The interesting number there is not
// latency, it is how many sandboxes got started — the broker is supposed to
// coalesce concurrent cold requests onto ONE spawn, and a regression shows up as
// N spawns rather than as a worse p99. Read the platform's log for the count;
// this reports what the callers saw.
//
// `--sessions` is the whole production path for a VOICE session, and it is worth
// knowing that the platform is only the first hop of it: `GET /:slug/
// client-config` answers with the GUEST's own `sessionUrl`
// (`ws://127.0.0.1:<port>/websocket`), so the browser then dials the sandbox
// DIRECTLY and no audio frame is ever proxied. That is why there is no proxied
// session row above and why this mode reports the two legs separately — a
// platform regression can only ever show up in the broker number.
//
// Two asymmetries to expect in the rows above, both correct behaviour rather
// than findings. A guest's own `/workflows` answers 401 when dialled directly,
// because it takes the per-sandbox bearer the platform injects — so DIRECT is
// comparable on the unauthenticated routes only. And the PROXIED `/workflows`
// row saturates `WORKFLOW_IP_RATE_LIMIT` (600 per 5 minutes per IP) within the
// first second and then reports a wall of 429s: measured at 600 x 404 (the agent
// declares no workflow) followed by 18,983 x 429. Read that row as the rate
// limit working, and read the rate rather than the failures.
//
// Global `fetch` and `WebSocket` (Node 22+), so this has no dependencies.

import { valueReader } from "./_args.mjs";

const arg = valueReader(process.argv.slice(2));

const PLATFORM = arg("platform", "http://127.0.0.1:8080");
const SLUG = arg("slug", "bench");
const GUEST = arg("guest", "");
const CONCURRENCY = Number(arg("concurrency", "20"));
const DURATION_MS = Number(arg("duration", "6")) * 1000;
const COLD = Number(arg("cold", "0"));
const SESSIONS = Number(arg("sessions", "0"));

const pct = (sorted, p) =>
  sorted.length > 0
    ? Number(
        sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)].toFixed(1),
      )
    : 0;

/** One closed-loop run against `url`: CONCURRENCY workers until the deadline. */
async function drive(url) {
  const samples = [];
  const errors = new Map();
  const deadline = Date.now() + DURATION_MS;
  const started = Date.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (Date.now() < deadline) {
        const at = performance.now();
        try {
          const res = await fetch(url);
          // The body has to be DRAINED, not just awaited: an undrained response
          // holds its connection, and the run then measures the pool rather
          // than the server.
          await res.arrayBuffer();
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          samples.push(performance.now() - at);
        } catch (err) {
          const key = String(err?.message ?? err).slice(0, 60);
          errors.set(key, (errors.get(key) ?? 0) + 1);
        }
      }
    }),
  );
  const elapsedMs = Date.now() - started;
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    url,
    ok: samples.length,
    failed: [...errors.values()].reduce((a, b) => a + b, 0),
    rps: Number(((samples.length / elapsedMs) * 1000).toFixed(1)),
    ms: { p50: pct(sorted, 50), p90: pct(sorted, 90), p99: pct(sorted, 99) },
    errors: Object.fromEntries(errors),
  };
}

/** COLD is about the SPAWN count, so every request goes out at once. */
async function coldBurst() {
  const at = performance.now();
  const results = await Promise.allSettled(
    Array.from({ length: COLD }, async () => {
      const res = await fetch(`${PLATFORM}/${SLUG}/client-config`);
      await res.arrayBuffer();
      return res.status;
    }),
  );
  const statuses = new Map();
  for (const one of results) {
    const key =
      one.status === "fulfilled"
        ? `HTTP ${one.value}`
        : String(one.reason?.message ?? one.reason).slice(0, 60);
    statuses.set(key, (statuses.get(key) ?? 0) + 1);
  }
  return {
    requests: COLD,
    wallMs: Number((performance.now() - at).toFixed(1)),
    statuses: Object.fromEntries(statuses),
  };
}

/**
 * One voice session the way a browser takes it: broker, then the guest DIRECTLY.
 *
 * Both legs timed, because they answer different questions — the first is the
 * platform's, the second is the agent's, and a single number would hide which
 * moved.
 */
async function oneSession() {
  const brokerAt = performance.now();
  const res = await fetch(`${PLATFORM}/${SLUG}/client-config`);
  const config = /** @type {{ sessionUrl?: string }} */ (await res.json());
  if (!res.ok) throw new Error(`client-config HTTP ${res.status}`);
  const brokerMs = performance.now() - brokerAt;
  // Bound to a local: the guard below does not reach inside the promise
  // executor, a closure being free to observe a later `config.sessionUrl`.
  const sessionUrl = config.sessionUrl;
  if (!sessionUrl) throw new Error("client-config carried no sessionUrl");

  const sessionAt = performance.now();
  const configured = await new Promise((resolve, reject) => {
    const ws = new WebSocket(sessionUrl);
    const timer = setTimeout(
      () => reject(new Error("timeout awaiting session.configured")),
      20_000,
    );
    const finish = (err) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // Already closing; the verdict is decided either way.
      }
      if (err) reject(err);
      else resolve(performance.now() - sessionAt);
    };
    ws.addEventListener("open", () =>
      ws.send(JSON.stringify({ type: "start", sampleRate: 16_000 })),
    );
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const frame = JSON.parse(event.data);
      // `session.configured` is the mark: a provider failure after it is the
      // agent's credentials, not the path under test.
      if (frame.type === "session.configured") finish();
      else if (frame.type === "error.reported" && frame.fatal) finish(new Error(`${frame.code}`));
    });
    ws.addEventListener("error", () => finish(new Error("session socket error")));
    ws.addEventListener("close", (event) => finish(new Error(`session closed ${event.code}`)));
  });
  return { brokerMs, sessionMs: configured };
}

/** SESSIONS of them at once — the burst an arrival spike really is. */
async function sessionBurst() {
  const results = await Promise.allSettled(Array.from({ length: SESSIONS }, () => oneSession()));
  const broker = [];
  const session = [];
  const errors = new Map();
  for (const one of results) {
    if (one.status === "fulfilled") {
      broker.push(one.value.brokerMs);
      session.push(one.value.sessionMs);
      continue;
    }
    const key = String(one.reason?.message ?? one.reason).slice(0, 60);
    errors.set(key, (errors.get(key) ?? 0) + 1);
  }
  const stat = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return { p50: pct(sorted, 50), p90: pct(sorted, 90), max: pct(sorted, 100) };
  };
  return {
    requested: SESSIONS,
    configured: session.length,
    brokerMs: stat(broker),
    sessionMs: stat(session),
    errors: Object.fromEntries(errors),
  };
}

const targets = [
  // Answered by the platform itself, so it is the floor every proxied number is
  // read against — no deploy lookup, no sandbox.
  ["platform /health", `${PLATFORM}/health`],
  [`platform /${SLUG}/client-config (PROXIED)`, `${PLATFORM}/${SLUG}/client-config`],
  [`platform /${SLUG}/workflows (PROXIED)`, `${PLATFORM}/${SLUG}/workflows`],
  ...(GUEST
    ? [
        ["guest /client-config (DIRECT)", `${GUEST}/client-config`],
        ["guest /workflows (DIRECT)", `${GUEST}/workflows`],
      ]
    : []),
];

if (!GUEST) {
  console.log("no --guest: reporting the proxied side only, with nothing to subtract.\n");
}

// FIRST, before any row below warms the deploy. Run last it measured a warm
// guest — 20 requests in 12ms — while the `client-config` row above had
// silently paid the 1855ms spawn and reported it as a latency.
if (COLD > 0) {
  console.log(`cold burst: ${JSON.stringify(await coldBurst())}`);
  console.log("read the platform's log for the SPAWN count — one is the pass.\n");
}

for (const [label, url] of targets) {
  const r = await drive(url);
  const cell = (n, w) => String(n).padStart(w);
  console.log(
    `${label.padEnd(44)} rps=${cell(r.rps, 8)}  p50=${cell(r.ms.p50, 6)}  p90=${cell(r.ms.p90, 7)}  p99=${cell(r.ms.p99, 8)}  fail=${r.failed}`,
  );
  if (r.failed > 0) console.log(`   ${JSON.stringify(r.errors)}`);
}

if (SESSIONS > 0) {
  console.log(`\nsession burst: ${JSON.stringify(await sessionBurst())}`);
}
