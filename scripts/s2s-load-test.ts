/**
 * S2S API load test — drives complete sessions by streaming Kokoro TTS audio.
 * Includes tool calling, barge-in simulation, connection retries, and optional
 * network chaos via Toxiproxy.
 *
 * Usage:
 *   npx tsx scripts/s2s-load-test.ts [options]
 *   npx tsx scripts/s2s-load-test.ts --help
 */

import { createRequire } from "node:module";
import { defineCommand, runMain } from "citty";
import {
  connectS2s,
  type CreateS2sWebSocket,
  defaultCreateS2sWebSocket,
  type S2sHandle,
  type S2sToolSchema,
} from "../packages/aai-core/host/s2s.ts";

// ── Config ───────────────────────────────────────────────────────────────────

type Config = {
  totalSessions: number;
  concurrency: number;
  wssUrl: string;
  apiKey: string;
  greeting: string;
  voice: string;
  maxTurns: number;
  chunkMs: number;
  rampMs: number;
  quiet: boolean;
  toxicLatency: number;
  toxicJitter: number;
  toxicBandwidth: number;
  toxicReset: number;
  noToxiproxy: boolean;
};

const INPUT_SAMPLE_RATE = 16_000;
const MAX_RETRIES = 5;
const BARGE_IN_CHANCE = 0.2;

// ── Tools & utterances ───────────────────────────────────────────────────────

const TOOLS: S2sToolSchema[] = [
  {
    type: "function",
    name: "get_weather",
    description: "Get the current weather for a location.",
    parameters: {
      type: "object",
      properties: { location: { type: "string", description: "City name" } },
      required: ["location"],
    },
  },
  {
    type: "function",
    name: "search_web",
    description: "Search the web for information.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "book_appointment",
    description: "Book an appointment at a given date and time.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date in YYYY-MM-DD format" },
        time: { type: "string", description: "Time in HH:MM format" },
        name: { type: "string", description: "Name for the appointment" },
      },
      required: ["date", "time", "name"],
    },
  },
  {
    type: "function",
    name: "get_store_hours",
    description: "Get store hours for a given day of the week.",
    parameters: {
      type: "object",
      properties: { day: { type: "string", description: "Day of the week" } },
      required: ["day"],
    },
  },
];

const TOOL_RESPONSES: Record<string, (args: Record<string, unknown>) => string> = {
  get_weather: (a) =>
    JSON.stringify({ temperature: "72F", condition: "sunny", location: a.location ?? "unknown" }),
  search_web: (a) =>
    JSON.stringify({
      results: [{ title: `Result for: ${a.query}`, snippet: "Here is some useful information." }],
    }),
  book_appointment: (a) =>
    JSON.stringify({ confirmed: true, date: a.date, time: a.time, name: a.name }),
  get_store_hours: (a) =>
    JSON.stringify({ day: a.day, open: "9:00 AM", close: "9:00 PM" }),
};

const UTTERANCES = [
  "What's the weather like in San Francisco right now?",
  "Can you search the web for the best Italian restaurants nearby?",
  "I'd like to book an appointment for tomorrow at 2 PM, my name is Alex.",
  "What time does the store close on Saturday?",
  "What's the weather in New York today?",
  "Search for how to make sourdough bread.",
  "Book me an appointment next Monday at 10 AM, name is Jordan.",
  "What are the store hours on Sunday?",
  "Search for tips on growing tomatoes in a small garden.",
  "What's the weather like in Chicago this weekend?",
];

const SYSTEM_PROMPT = `You are a helpful voice assistant. Keep responses brief — one or two sentences.
You MUST use the provided tools to answer questions. Always call the appropriate tool before responding.
- For weather questions, use get_weather.
- For general knowledge or search questions, use search_web.
- For booking requests, use book_appointment.
- For store hours questions, use get_store_hours.`;

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// ── TTS generation ───────────────────────────────────────────────────────────

type TTS = {
  generate(text: string, opts: { voice: string }): Promise<{ audio: Float32Array; sampling_rate: number }>;
};

function resample(samples: Float32Array, srcRate: number, dstRate: number): Float32Array {
  if (srcRate === dstRate) return samples;
  const ratio = srcRate / dstRate;
  const outLen = Math.floor(samples.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * ratio;
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, samples.length - 1);
    const frac = srcIdx - lo;
    out[i] = samples[lo]! * (1 - frac) + samples[hi]! * frac;
  }
  return out;
}

function float32ToPcm16(samples: Float32Array): Uint8Array {
  const buf = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
  }
  return new Uint8Array(buf);
}

async function generateAudioBuffers(tts: TTS, voice: string): Promise<Uint8Array[]> {
  const buffers: Uint8Array[] = [];
  for (let i = 0; i < UTTERANCES.length; i++) {
    const text = UTTERANCES[i]!;
    process.stdout.write(`  TTS [${i + 1}/${UTTERANCES.length}] "${text.slice(0, 50)}..." `);
    const result = await tts.generate(text, { voice });
    const resampled = resample(result.audio, result.sampling_rate, INPUT_SAMPLE_RATE);
    const pcm = float32ToPcm16(resampled);
    console.log(`${(resampled.length / INPUT_SAMPLE_RATE).toFixed(2)}s (${pcm.length} bytes)`);
    buffers.push(pcm);
  }
  return buffers;
}

// ── Metrics ──────────────────────────────────────────────────────────────────

type SessionMetrics = {
  sessionId: number;
  connected: boolean;
  sessionReady: boolean;
  turnsRequested: number;
  turnsCompleted: number;
  userTranscripts: string[];
  agentTranscripts: string[];
  toolCalls: { turn: number; name: string; args: Record<string, unknown> }[];
  errors: string[];
  connectMs: number;
  firstGreetingMs: number;
  turnLatenciesMs: number[];
  totalMs: number;
  retries: number;
  bargeIns: number;
};

function percentile(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function printMetrics(results: SessionMetrics[], peakConcurrency: number): void {
  // Per-session results
  console.log("\n" + "=".repeat(70));
  console.log("RESULTS");
  console.log("=".repeat(70));
  for (const r of results) {
    console.log(`\n--- Session ${r.sessionId} ---`);
    console.log(`  Connected:        ${r.connected}`);
    console.log(`  Session ready:    ${r.sessionReady}`);
    console.log(`  Connect time:     ${r.connectMs}ms`);
    console.log(`  First greeting:   ${r.firstGreetingMs > 0 ? `${r.firstGreetingMs}ms` : "n/a"}`);
    console.log(`  Turns completed:  ${r.turnsCompleted}/${r.turnsRequested}`);
    if (r.turnLatenciesMs.length > 0) {
      console.log(`  Turn latencies:   ${r.turnLatenciesMs.map((l) => `${l}ms`).join(", ")}`);
    }
    console.log(`  Tool calls:       ${r.toolCalls.length}`);
    for (const tc of r.toolCalls) {
      console.log(`    [turn ${tc.turn}] ${tc.name}(${JSON.stringify(tc.args)})`);
    }
    console.log(`  Total time:       ${r.totalMs}ms`);
    if (r.userTranscripts.length > 0) {
      console.log(`  User transcripts: ${r.userTranscripts.map((t) => `"${t}"`).join(", ")}`);
    }
    if (r.agentTranscripts.length > 0) {
      console.log(`  Agent responses:  ${r.agentTranscripts.map((t) => `"${t.slice(0, 60)}${t.length > 60 ? "..." : ""}"`).join(", ")}`);
    }
    if (r.errors.length > 0) {
      console.log(`  Errors:           ${r.errors.join("; ")}`);
    }
  }

  // Errors
  const allErrors = results.flatMap((r) => r.errors.map((e) => ({ session: r.sessionId, error: e })));
  console.log("\n" + "=".repeat(70));
  console.log("ERRORS");
  console.log("=".repeat(70));
  if (allErrors.length === 0) {
    console.log("  (none)");
  } else {
    const groups: Record<string, typeof allErrors> = {
      WebSocket: allErrors.filter((e) => e.error.startsWith("ws ")),
      API: allErrors.filter((e) => e.error.startsWith("s2s error:") || e.error.startsWith("s2s expired:")),
      Timeouts: allErrors.filter((e) => e.error.startsWith("session timeout")),
      Validation: allErrors.filter((e) => e.error.startsWith("FAIL:")),
    };
    console.log(`  Total:            ${allErrors.length}`);
    for (const [label, errs] of Object.entries(groups)) {
      if (errs.length === 0) continue;
      console.log(`  ${label.padEnd(18)}${errs.length}`);
      for (const e of errs) console.log(`    [s${e.session}] ${e.error}`);
    }
  }

  // Aggregate
  const allLatencies = results.flatMap((r) => r.turnLatenciesMs).sort((a, b) => a - b);
  const greetingLatencies = results.map((r) => r.firstGreetingMs).filter((l) => l > 0).sort((a, b) => a - b);
  const withErrors = results.filter((r) => r.errors.length > 0);
  const clean = results.length - withErrors.length;
  const totalTurns = results.reduce((s, r) => s + r.turnsCompleted, 0);
  const cleanTurns = results.filter((r) => r.errors.length === 0).reduce((s, r) => s + r.turnsCompleted, 0);

  console.log("\n" + "=".repeat(70));
  console.log("AGGREGATE");
  console.log("=".repeat(70));
  console.log(`  Sessions:         ${results.length} total, ${clean} clean, ${withErrors.length} with errors`);
  console.log(`  Peak concurrency: ${peakConcurrency}`);
  console.log(`  Turns:            ${totalTurns} total, ${cleanTurns} clean, ${totalTurns - cleanTurns} with errors`);
  console.log(`  Total tool calls: ${results.reduce((s, r) => s + r.toolCalls.length, 0)}`);
  console.log(`  Retries:          ${results.reduce((s, r) => s + r.retries, 0)}`);
  console.log(`  Barge-ins:        ${results.reduce((s, r) => s + r.bargeIns, 0)}`);
  if (greetingLatencies.length > 0) {
    console.log(`  Greeting p50:     ${percentile(greetingLatencies, 50)}ms`);
    console.log(`  Greeting p95:     ${percentile(greetingLatencies, 95)}ms`);
  }
  if (allLatencies.length > 0) {
    console.log(`  Turn latency p50: ${percentile(allLatencies, 50)}ms`);
    console.log(`  Turn latency p95: ${percentile(allLatencies, 95)}ms`);
    console.log(`  Turn latency p99: ${percentile(allLatencies, 99)}ms`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

/**
 * Random turn count with distribution averaging ~8 user turns.
 * 10% → 1-2, 15% → 3-4, 25% → 5-7, 25% → 8-10, 15% → 11-14, 10% → 15-20
 */
function randomTurnCount(maxTurns: number): number {
  const r = Math.random();
  let turns: number;
  if (r < 0.10) turns = 1 + Math.floor(Math.random() * 2);       // 1-2
  else if (r < 0.25) turns = 3 + Math.floor(Math.random() * 2);  // 3-4
  else if (r < 0.50) turns = 5 + Math.floor(Math.random() * 3);  // 5-7
  else if (r < 0.75) turns = 8 + Math.floor(Math.random() * 3);  // 8-10
  else if (r < 0.90) turns = 11 + Math.floor(Math.random() * 4); // 11-14
  else turns = 15 + Math.floor(Math.random() * 6);                // 15-20
  return Math.min(turns, maxTurns);
}

function randomPauseMs(): number {
  return 1000 + Math.floor(Math.random() * 5000);
}

// ── Session driver ───────────────────────────────────────────────────────────

async function runSession(
  sessionId: number,
  audioBuffers: Uint8Array[],
  createWebSocket: CreateS2sWebSocket,
  cfg: Config,
): Promise<SessionMetrics> {
  const sessionTurns = randomTurnCount(cfg.maxTurns);
  const bufferOrder = shuffle([...audioBuffers.keys()]);
  const log = cfg.quiet ? () => {} : (msg: string) => console.log(`  [s${sessionId}] ${msg}`);

  const metrics: SessionMetrics = {
    sessionId, connected: false, sessionReady: false,
    turnsRequested: sessionTurns, turnsCompleted: 0,
    userTranscripts: [], agentTranscripts: [], toolCalls: [], errors: [],
    connectMs: 0, firstGreetingMs: 0, turnLatenciesMs: [], totalMs: 0,
    retries: 0, bargeIns: 0,
  };

  const sessionStart = Date.now();
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      metrics.retries++;
      const backoff = Math.min(1000 * 2 ** (attempt - 1), 10_000);
      log(`retry ${attempt}/${MAX_RETRIES} after ${backoff}ms`);
      await sleep(backoff);
    }
    const result = await runSessionAttempt(sessionId, sessionTurns, bufferOrder, audioBuffers, metrics, sessionStart, log, createWebSocket, cfg);
    if (result === "done") break;
    if (attempt === MAX_RETRIES) {
      metrics.errors.push(`exhausted ${MAX_RETRIES} retries`);
      log(`exhausted ${MAX_RETRIES} retries`);
    }
  }

  metrics.totalMs = Date.now() - sessionStart;
  return metrics;
}

async function runSessionAttempt(
  sessionId: number,
  sessionTurns: number,
  bufferOrder: number[],
  audioBuffers: Uint8Array[],
  metrics: SessionMetrics,
  sessionStart: number,
  log: (msg: string) => void,
  createWebSocket: CreateS2sWebSocket,
  cfg: Config,
): Promise<"done" | "retry"> {
  let turnStart = 0;
  let currentTurn = metrics.turnsCompleted;
  let waitingForReply = false;
  let greetingReceived = metrics.agentTranscripts.length > 0;
  let gotAgentReplyThisTurn = false;
  let recordedLatencyThisTurn = false;
  let bargeInScheduled = false;
  let lastEvent = "init";
  let done = false;
  let shouldRetry = false;

  let handle: S2sHandle;
  try {
    handle = await connectS2s({
      apiKey: cfg.apiKey,
      config: { wssUrl: cfg.wssUrl, inputSampleRate: INPUT_SAMPLE_RATE, outputSampleRate: 24_000 },
      createWebSocket,
      logger: cfg.quiet ? silentLogger : console,
    });
    metrics.connected = true;
    metrics.connectMs = Date.now() - sessionStart;
    log(`connected (${metrics.connectMs}ms)`);
  } catch (err: unknown) {
    metrics.errors.push(`ws error: ${(err as Error).message}`);
    log(`ws error: ${(err as Error).message}`);
    return "retry";
  }

  return new Promise((resolve) => {
    const timeoutMs = sessionTurns * 30_000 + 30_000;
    const timeout = setTimeout(() => {
      const state = `turn=${currentTurn}/${sessionTurns}, greeting=${greetingReceived}, waitingForReply=${waitingForReply}, lastEvent=${lastEvent}`;
      metrics.errors.push(`session timeout (${timeoutMs / 1000}s) [${state}]`);
      log(`session timeout [${state}]`);
      finish();
    }, timeoutMs);

    function finish(): void {
      if (done) return;
      done = true;
      clearTimeout(timeout);

      if (metrics.connected && metrics.sessionReady && !greetingReceived) {
        metrics.errors.push("FAIL: no greeting received from agent");
      }
      if (waitingForReply && currentTurn > 0) {
        metrics.errors.push(`FAIL: turn ${currentTurn} got no agent reply`);
      }

      handle.close();
      resolve(shouldRetry ? "retry" : "done");
    }

    handle.on("ready", ({ sessionId: sid }) => {
      metrics.sessionReady = true;
      lastEvent = "ready";
      log(`session ready (id: ${sid})`);
    });

    handle.on("sessionUpdated", () => { lastEvent = "sessionUpdated"; log("session updated, waiting for greeting..."); });

    handle.on("toolCall", ({ callId, name, args: toolArgs }) => {
      lastEvent = "toolCall";
      log(`tool call [turn ${currentTurn}]: ${name}(${JSON.stringify(toolArgs)})`);
      const responder = TOOL_RESPONSES[name];
      const result = responder ? responder(toolArgs) : JSON.stringify({ error: `unknown tool: ${name}` });
      handle.sendToolResult(callId, result);
      metrics.toolCalls.push({ turn: currentTurn, name, args: toolArgs });
    });

    handle.on("speechStopped", () => {
      lastEvent = "speechStopped";
      if (waitingForReply) {
        turnStart = Date.now();
        log(`turn ${currentTurn} speech stopped, waiting for response...`);
      }
    });

    handle.on("agentTranscriptDelta", ({ text }) => {
      lastEvent = "agentTranscriptDelta";
      if (waitingForReply && !recordedLatencyThisTurn && turnStart > 0) {
        recordedLatencyThisTurn = true;
        const latency = Date.now() - turnStart;
        metrics.turnLatenciesMs.push(latency);
        log(`first agent token [turn ${currentTurn}]: "${text.slice(0, 40)}" (${latency}ms)`);
      }
      // Barge-in: interrupt agent mid-response by sending audio
      if (waitingForReply && bargeInScheduled && !done) {
        bargeInScheduled = false;
        metrics.bargeIns++;
        log(`barge-in [turn ${currentTurn}]: interrupting agent`);
        const bufIdx = bufferOrder[currentTurn % bufferOrder.length]!;
        const pcm = audioBuffers[bufIdx]!;
        const chunkBytes = Math.floor((INPUT_SAMPLE_RATE * cfg.chunkMs) / 1000) * 2;
        for (let offset = 0; offset < Math.min(pcm.length, chunkBytes * 5); offset += chunkBytes) {
          handle.sendAudio(pcm.subarray(offset, offset + chunkBytes));
        }
      }
    });

    handle.on("agentTranscript", ({ text }) => {
      lastEvent = "agentTranscript";
      metrics.agentTranscripts.push(text);
      if (!greetingReceived) {
        greetingReceived = true;
        metrics.firstGreetingMs = Date.now() - sessionStart;
        log(`greeting: "${text.slice(0, 60)}" (${metrics.firstGreetingMs}ms)`);
      } else if (waitingForReply) {
        gotAgentReplyThisTurn = true;
        log(`agent reply [turn ${currentTurn}]: "${text.slice(0, 60)}"`);
      }
    });

    handle.on("userTranscript", ({ text }) => {
      lastEvent = "userTranscript";
      metrics.userTranscripts.push(text);
      log(`user transcript [turn ${currentTurn}]: "${text}"`);
    });

    handle.on("replyDone", () => {
      lastEvent = "replyDone";
      if (waitingForReply && gotAgentReplyThisTurn) {
        waitingForReply = false;
        gotAgentReplyThisTurn = false;
        metrics.turnsCompleted++;
        if (currentTurn < sessionTurns) streamNextTurn();
        else { log("all turns completed"); finish(); }
      } else if (!waitingForReply && currentTurn < sessionTurns) {
        streamNextTurn();
      }
    });

    handle.on("error", ({ code, message }) => { metrics.errors.push(`s2s error: ${code} ${message}`); log(`error: ${code} ${message}`); });
    handle.on("sessionExpired", ({ code, message }) => { metrics.errors.push(`s2s expired: ${code} ${message}`); finish(); });
    handle.on("close", () => {
      log("ws closed");
      if (!done && metrics.turnsCompleted < sessionTurns) shouldRetry = true;
      finish();
    });

    handle.updateSession({ systemPrompt: SYSTEM_PROMPT, tools: TOOLS, greeting: cfg.greeting });

    async function streamNextTurn(): Promise<void> {
      currentTurn++;
      if (currentTurn > sessionTurns) return;

      bargeInScheduled = Math.random() < BARGE_IN_CHANCE;
      await sleep(randomPauseMs());
      if (done) return;

      const bufIdx = bufferOrder[(currentTurn - 1) % bufferOrder.length]!;
      const pcm = audioBuffers[bufIdx]!;
      const chunkBytes = Math.floor((INPUT_SAMPLE_RATE * cfg.chunkMs) / 1000) * 2;

      log(`streaming turn ${currentTurn}/${sessionTurns}${bargeInScheduled ? " (will barge-in)" : ""} (${(pcm.length / (INPUT_SAMPLE_RATE * 2)).toFixed(2)}s)`);
      waitingForReply = true;
      gotAgentReplyThisTurn = false;
      recordedLatencyThisTurn = false;
      turnStart = 0;

      for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
        if (done) return;
        handle.sendAudio(pcm.subarray(offset, offset + chunkBytes));
        await sleep(cfg.chunkMs);
      }
      log(`turn ${currentTurn} audio sent`);
    }
  });
}

// ── Toxiproxy setup ──────────────────────────────────────────────────────────

type ToxiproxyState = {
  createWebSocket: CreateS2sWebSocket;
  cleanup: () => Promise<void>;
};

let toxiproxyPid: number | null = null;

async function ensureToxiproxyServer(): Promise<void> {
  const { Toxiproxy } = await import("toxiproxy-node-client");
  const toxiproxy = new Toxiproxy("http://localhost:8474");
  try {
    await toxiproxy.getVersion();
    return; // already running
  } catch {
    // not running — try to start it
  }

  const { execFileSync, spawn } = await import("node:child_process");
  try {
    execFileSync("which", ["toxiproxy-server"], { stdio: "ignore" });
  } catch {
    throw new Error("toxiproxy-server not found. Install: brew install toxiproxy");
  }

  console.log("  Toxiproxy: starting server...");
  const proc = spawn("toxiproxy-server", [], { stdio: "ignore", detached: true });
  proc.unref();
  toxiproxyPid = proc.pid ?? null;

  // Wait for it to be ready
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    try { await toxiproxy.getVersion(); return; } catch {}
  }
  throw new Error("Toxiproxy server failed to start within 5 seconds");
}

async function setupToxiproxy(wssUrl: string, cfg: Config): Promise<ToxiproxyState> {
  const { Toxiproxy } = await import("toxiproxy-node-client");
  const require = createRequire(import.meta.url);
  const WsWebSocket = require("ws") as typeof import("ws").default;

  await ensureToxiproxyServer();

  const toxiproxy = new Toxiproxy("http://localhost:8474");
  const url = new URL(wssUrl);
  const upstreamHost = url.hostname;
  const upstreamPort = url.port || "443";

  const proxy = await toxiproxy.createProxy({
    name: `s2s-loadtest-${Date.now()}`,
    listen: "localhost:0",
    upstream: `${upstreamHost}:${upstreamPort}`,
  });
  const [proxyHost, proxyPort] = proxy.listen.split(":");
  console.log(`  Toxiproxy: proxy ${proxy.listen} → ${upstreamHost}:${upstreamPort}`);

  // Add toxics
  const addToxic = async (body: unknown) => {
    try {
      await proxy.addToxic(body as never);
    } catch (err: unknown) {
      const axErr = err as { response?: { data?: unknown; status?: number } };
      const detail = axErr.response?.data ? JSON.stringify(axErr.response.data) : (err as Error).message;
      throw new Error(`Toxiproxy addToxic failed for ${JSON.stringify(body)}: ${detail}`);
    }
  };
  if (cfg.toxicLatency > 0 || cfg.toxicJitter > 0) {
    await addToxic({ type: "latency", name: "latency_downstream", stream: "downstream", toxicity: 1.0, attributes: { latency: cfg.toxicLatency, jitter: cfg.toxicJitter } });
    await addToxic({ type: "latency", name: "latency_upstream", stream: "upstream", toxicity: 1.0, attributes: { latency: Math.floor(cfg.toxicLatency / 2), jitter: Math.floor(cfg.toxicJitter / 2) } });
    console.log(`  Toxiproxy: +latency ${cfg.toxicLatency}ms ±${cfg.toxicJitter}ms`);
  }
  if (cfg.toxicBandwidth > 0) {
    await addToxic({ type: "bandwidth", name: "bandwidth_downstream", stream: "downstream", toxicity: 1.0, attributes: { rate: cfg.toxicBandwidth } });
    console.log(`  Toxiproxy: +bandwidth limit ${cfg.toxicBandwidth} KB/s`);
  }
  if (cfg.toxicReset > 0) {
    await addToxic({ type: "reset_peer", name: "reset_downstream", stream: "downstream", toxicity: cfg.toxicReset, attributes: { timeout: 5000 } });
    console.log(`  Toxiproxy: +reset ${(cfg.toxicReset * 100).toFixed(1)}% of connections`);
  }

  const createWebSocket: CreateS2sWebSocket = ((originalUrl: string, opts: { headers: Record<string, string> }) => {
    const parsed = new URL(originalUrl);
    return new WsWebSocket(`wss://${proxyHost}:${proxyPort}${parsed.pathname}${parsed.search}`, {
      headers: opts.headers,
      rejectUnauthorized: false,
      servername: upstreamHost,
    });
  }) as unknown as CreateS2sWebSocket;

  return {
    createWebSocket,
    cleanup: async () => {
      try { await proxy.remove(); } catch {}
      if (toxiproxyPid) {
        try { process.kill(toxiproxyPid); console.log("  Toxiproxy: server stopped"); } catch {}
        toxiproxyPid = null;
      }
    },
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(cfg: Config): Promise<void> {
  console.log("S2S Load Test");
  console.log("=".repeat(70));
  console.log(`  URL:         ${cfg.wssUrl}`);
  console.log(`  Sessions:    ${cfg.totalSessions}`);
  console.log(`  Concurrency: ${cfg.concurrency}`);
  console.log(`  Max turns:   ${cfg.maxTurns} (randomized per session)`);
  console.log(`  Chunk size:  ${cfg.chunkMs}ms`);
  console.log(`  Ramp-up:     ${cfg.rampMs > 0 ? `${cfg.rampMs}ms` : "off (all at once)"}`);
  console.log(`  Verbose:     ${!cfg.quiet}`);
  console.log(`  Voice:       ${cfg.voice}`);
  console.log(`  Greeting:    "${cfg.greeting}"`);
  console.log(`  Tools:       ${TOOLS.map((t) => t.name).join(", ")}`);
  console.log();

  // Toxiproxy — enabled unless --no-toxiproxy
  let wsFactory: CreateS2sWebSocket;
  let toxiState: ToxiproxyState | null = null;
  if (cfg.noToxiproxy) {
    console.log("  Toxiproxy: SKIPPED (--no-toxiproxy)");
    wsFactory = defaultCreateS2sWebSocket;
  } else {
    toxiState = await setupToxiproxy(cfg.wssUrl, cfg);
    wsFactory = toxiState.createWebSocket;
  }
  console.log();

  // TTS
  console.log("Generating TTS audio with Kokoro...");
  const { KokoroTTS } = await import("kokoro-js");
  const require = createRequire(import.meta.url);
  const voicesPath = require.resolve("kokoro-js").replace(/dist.*/, "voices/");
  const tts = await KokoroTTS.from_pretrained(
    "onnx-community/Kokoro-82M-v1.0-ONNX",
    // @ts-expect-error voices_path is supported at runtime but missing from types
    { dtype: "q8", device: "cpu", voices_path: voicesPath },
  );
  const audioBuffers = await generateAudioBuffers(tts as unknown as TTS, cfg.voice);
  console.log(`Generated ${audioBuffers.length} audio buffers\n`);

  // Worker pool
  console.log(`Running ${cfg.totalSessions} session(s), ${cfg.concurrency} at a time...\n`);
  const startTime = Date.now();
  const results: SessionMetrics[] = [];
  let nextId = 0;
  let completed = 0;
  let active = 0;
  let peakConcurrency = 0;

  const progressInterval = cfg.quiet
    ? setInterval(() => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const line = `  Progress: ${completed}/${cfg.totalSessions} done, ${active} active, peak ${peakConcurrency}, ${elapsed}s elapsed`;
        process.stdout.write(`\r${line.padEnd(100)}`);
      }, 1000)
    : null;

  async function worker(): Promise<void> {
    while (nextId < cfg.totalSessions) {
      const id = nextId++;
      active++;
      if (active > peakConcurrency) peakConcurrency = active;
      const result = await runSession(id, audioBuffers, wsFactory, cfg);
      active--;
      results.push(result);
      completed++;
    }
  }

  const numWorkers = Math.min(cfg.concurrency, cfg.totalSessions);
  if (cfg.rampMs > 0 && numWorkers > 1) {
    const delayPerWorker = cfg.rampMs / numWorkers;
    const workers: Promise<void>[] = [];
    for (let i = 0; i < numWorkers; i++) {
      if (i > 0) await sleep(delayPerWorker);
      workers.push(worker());
    }
    await Promise.all(workers);
  } else {
    await Promise.all(Array.from({ length: numWorkers }, () => worker()));
  }

  if (progressInterval) { clearInterval(progressInterval); process.stdout.write("\n"); }

  results.sort((a, b) => a.sessionId - b.sessionId);
  console.log(`\nAll sessions finished in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  printMetrics(results, peakConcurrency);

  await toxiState?.cleanup();
  process.exitCode = results.some((r) => r.errors.some((e) => e.startsWith("FAIL:"))) ? 1 : 0;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const loadTestCommand = defineCommand({
  meta: { name: "s2s-load-test", description: "S2S API load test with realistic traffic simulation" },
  args: {
    sessions: { type: "string", alias: "n", description: "Total number of sessions to run", default: "10000" },
    concurrency: { type: "string", alias: "c", description: "Max simultaneous sessions", default: "2500" },
    url: { type: "string", description: "S2S WebSocket URL", default: "wss://speech-to-speech.us.assemblyai.com/v1/realtime" },
    greeting: { type: "string", description: "Agent greeting text", default: "Hello, how can I help?" },
    voice: { type: "string", description: "Kokoro voice preset", default: "af_heart" },
    turns: { type: "string", description: "Max user turns per session (randomized, avg ~8)", default: "20" },
    chunkMs: { type: "string", description: "Audio chunk size in ms", default: "100" },
    rampMs: { type: "string", description: "Stagger session starts over this many ms", default: "300000" },
    verbose: { type: "boolean", alias: "v", description: "Show per-session event logs", default: false },
    toxicLatency: { type: "string", description: "Added latency in ms (real-world ~40ms, default 20% worse)", default: "50" },
    toxicJitter: { type: "string", description: "Latency jitter in ms (real-world ~15ms, default 20% worse)", default: "20" },
    toxicBandwidth: { type: "string", description: "Bandwidth limit in KB/s (0 = unlimited)", default: "0" },
    toxicReset: { type: "string", description: "Connection drop probability (real-world ~1-2%, default 20% worse)", default: "0.025" },
    noToxiproxy: { type: "boolean", description: "Skip Toxiproxy, connect directly", default: false },
  },
  async run({ args }) {
    const apiKey = process.env.ASSEMBLYAI_API_KEY ?? "";
    if (!apiKey) {
      console.error("Error: $ASSEMBLYAI_API_KEY environment variable is required");
      process.exit(1);
    }
    await main({
      totalSessions: Number(args.sessions),
      concurrency: Number(args.concurrency),
      wssUrl: args.url,
      apiKey,
      greeting: args.greeting,
      voice: args.voice,
      maxTurns: Number(args.turns),
      chunkMs: Number(args.chunkMs),
      rampMs: Number(args.rampMs),
      quiet: !args.verbose,
      toxicLatency: Number(args.toxicLatency),
      toxicJitter: Number(args.toxicJitter),
      toxicBandwidth: Number(args.toxicBandwidth),
      toxicReset: Number(args.toxicReset),
      noToxiproxy: args.noToxiproxy,
    });
  },
});

runMain(loadTestCommand);
