#!/usr/bin/env node
// Load harness for template agents running under `aai dev`.
//
// Three scenarios, each hitting a different tier of the stack:
//
//   http      — GET /health and /client-config. Pure request path, no database.
//               The baseline the other numbers are read against.
//   workflow  — POST /workflows/runs, then GET the run back. Every request is a
//               durable run (rows in workflow.workflow_runs + workflow_events),
//               so this is the Postgres write path under concurrency.
//   session   — the voice-session WebSocket, opened to `session.configured` and
//               closed. Exercises session creation and the Postgres session
//               event log. Without a real provider key a session still dies at
//               STT/TTS, so what this measures is handshake + persistence, not
//               a full conversational turn.
//
// Closed-loop by design: each of N workers issues one request, waits for it,
// and repeats. That measures service latency at a fixed concurrency rather than
// queueing an open-loop backlog the server never had a chance to refuse.
//
// POINT IT AT THE BACKEND PORT. A template with a `client.tsx` is served by two
// listeners — Vite on the declared port, the agent backend on the next free one
// above it — and both answer /health, so aiming at the wrong one silently
// measures the dev proxy. That hop cost ~144x on WebSocket upgrades when this
// was written (1.7 rps / p90 2008ms through Vite, 245 rps / p99 13ms direct),
// which is a dev-server artifact and not the agent runtime. `--ports` is how
// you say which you mean; `loadtest-boot.sh` prints the backend port it found.
//
// Uses the global WebSocket and fetch, so it has no dependencies and can run
// from anywhere.

import { valueReader } from "./_args.mjs";

const arg = valueReader(process.argv.slice(2));

const SCENARIO = arg("scenario", "http");
const CONCURRENCY = Number(arg("concurrency", "20"));
const DURATION_MS = Number(arg("duration", "10")) * 1000;

/** `name=port,name=port` — the backend port for each agent under test. */
const PORTS = Object.fromEntries(
  // `String(...)`: a bare `--ports` reads as `true` (see `valueReader`).
  String(arg("ports", "simple-agent=4110"))
    .split(",")
    .filter(Boolean)
    .map((pair) => {
      const [name, port] = pair.split("=");
      return [name, Number(port)];
    }),
);

/** Percentile over an ASCENDING copy — the caller keeps arrival order. */
function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[i];
}

function report(target, samples, errors, elapsedMs) {
  const sorted = [...samples].sort((a, b) => a - b);
  const round = (n) => Number(n.toFixed(1));
  return {
    target,
    ok: samples.length,
    failed: [...errors.values()].reduce((a, b) => a + b, 0),
    rps: round((samples.length / elapsedMs) * 1000),
    ms: {
      p50: round(pct(sorted, 50)),
      p90: round(pct(sorted, 90)),
      p99: round(pct(sorted, 99)),
      max: round(sorted.at(-1) ?? 0),
    },
    errors: Object.fromEntries(errors),
  };
}

/** Run `once()` on CONCURRENCY workers until the deadline. */
async function drive(once) {
  const samples = [];
  const errors = new Map();
  const deadline = Date.now() + DURATION_MS;
  const started = Date.now();
  const worker = async () => {
    while (Date.now() < deadline) {
      const t = performance.now();
      try {
        await once();
        samples.push(performance.now() - t);
      } catch (err) {
        // Truncated: an error carrying a whole stack would make the report
        // unreadable, and the shape is what distinguishes one failure from another.
        const key = String(err?.message ?? err).slice(0, 80);
        errors.set(key, (errors.get(key) ?? 0) + 1);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { samples, errors, elapsedMs: Date.now() - started };
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function httpScenario() {
  const out = [];
  for (const [name, port] of Object.entries(PORTS)) {
    for (const path of ["/health", "/client-config"]) {
      const r = await drive(() => getJson(`http://localhost:${port}${path}`));
      out.push(report(`${name} ${path}`, r.samples, r.errors, r.elapsedMs));
    }
  }
  return out;
}

/**
 * A run body per workflow-bearing template. Inputs are deliberately ones the
 * run can ACCEPT — the run is expected to fail later at a step that wants a
 * provider key, which still exercises the whole durable path (create, schedule,
 * execute, persist a terminal status). A body the API rejects at validation
 * would measure the 400 path instead.
 */
const WORKFLOW_INPUT = {
  "research-workflow": {
    workflow: "research",
    input: { topic: "durable workflows under load", requestedBy: "loadtest" },
  },
  "transcription-workflow": {
    workflow: "transcribe",
    input: { recording: "https://example.invalid/standup.wav" },
  },
};

async function workflowScenario() {
  const out = [];
  for (const [name, port] of Object.entries(PORTS)) {
    const body = WORKFLOW_INPUT[name];
    if (!body) continue;
    const r = await drive(async () => {
      const res = await fetch(`http://localhost:${port}/workflows/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`start HTTP ${res.status}`);
      const { runId } = /** @type {{ runId?: string }} */ (await res.json());
      if (!runId) throw new Error("start returned no runId");
      // Read it back: a run must be durably addressable straight away.
      const read = await fetch(`http://localhost:${port}/workflows/runs/${runId}`);
      if (!read.ok) throw new Error(`read HTTP ${read.status}`);
      await read.json();
    });
    out.push(report(`${name} POST+GET /workflows/runs`, r.samples, r.errors, r.elapsedMs));
  }
  return out;
}

/**
 * Open a session, resolve on `session.configured`, close.
 *
 * `@returns` is load-bearing, not decoration: without it the promise's value
 * type is inferred as `unknown`, and `resolve()` with no argument is then an
 * arity error rather than the "resolved with nothing" this means.
 *
 * @returns {Promise<void>}
 */
function openSession(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/websocket`);
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closing — the result is decided either way */
      }
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error("timeout awaiting session.configured")),
      20_000,
    );
    ws.addEventListener("open", () =>
      ws.send(JSON.stringify({ type: "start", sampleRate: 16_000 })),
    );
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") return;
      let frame;
      try {
        frame = JSON.parse(ev.data);
      } catch {
        return;
      }
      // The handshake is complete at `session.configured`. Provider errors
      // arrive AFTER it and are expected without a real key, so they must not
      // be counted as a failure of the thing being measured.
      if (frame.type === "session.configured") finish();
      else if (frame.type === "error.reported" && frame.code === "internal") {
        finish(new Error(`internal: ${frame.message}`));
      }
    });
    ws.addEventListener("error", () => finish(new Error("socket error")));
    // A `page: "static"` agent serves no voice session and closes with 1008.
    ws.addEventListener("close", (ev) => finish(new Error(`closed ${ev.code}`)));
  });
}

async function sessionScenario() {
  const out = [];
  for (const [name, port] of Object.entries(PORTS)) {
    const r = await drive(() => openSession(port));
    out.push(report(`${name} ws /websocket handshake`, r.samples, r.errors, r.elapsedMs));
  }
  return out;
}

const RUNNERS = { http: httpScenario, workflow: workflowScenario, session: sessionScenario };
const runner = RUNNERS[SCENARIO];
if (!runner) {
  console.error(`unknown scenario "${SCENARIO}" — expected one of ${Object.keys(RUNNERS)}`);
  process.exit(2);
}
if (Object.keys(PORTS).length === 0) {
  console.error("no targets — pass --ports=name=port[,name=port]");
  process.exit(2);
}
console.log(
  JSON.stringify(
    {
      scenario: SCENARIO,
      concurrency: CONCURRENCY,
      durationSec: DURATION_MS / 1000,
      results: await runner(),
    },
    null,
    2,
  ),
);
