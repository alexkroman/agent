/**
 * S2S API load test — drives complete sessions by streaming Kokoro TTS audio.
 * Includes tool calling: registers tools in the session and responds to tool.call
 * messages from the agent with mock tool.result responses.
 *
 * Usage:
 *   npx tsx scripts/s2s-load-test.ts [options]
 *
 * Options:
 *   --sessions, -n       Total number of sessions to run (default: 1)
 *   --concurrency, -c    Max simultaneous sessions (default: 1)
 *   --url                S2S WebSocket URL (default: wss://speech-to-speech.us.assemblyai.com/v1/realtime)
 *   --api-key            AssemblyAI API key (default: $ASSEMBLYAI_API_KEY)
 *   --greeting           Agent greeting text (default: "Hello, how can I help?")
 *   --voice              Kokoro voice preset (default: af_heart)
 *   --turns              Number of user turns per session (default: 3)
 *   --chunk-ms           Audio chunk size in ms when streaming (default: 100)
 *   --pause-ms           Pause between turns in ms (default: 2000)
 */

import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import {
  connectS2s,
  defaultCreateS2sWebSocket,
  type S2sHandle,
  type S2sToolSchema,
} from "../packages/aai/host/s2s.ts";

// ── CLI args ──────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    sessions: { type: "string", short: "n", default: "1" },
    concurrency: { type: "string", short: "c", default: "1" },
    url: {
      type: "string",
      default: "wss://speech-to-speech.us.assemblyai.com/v1/realtime",
    },
    "api-key": { type: "string", default: process.env.ASSEMBLYAI_API_KEY ?? "" },
    greeting: { type: "string", default: "Hello, how can I help?" },
    voice: { type: "string", default: "af_heart" },
    turns: { type: "string", default: "3" },
    "chunk-ms": { type: "string", default: "100" },
    "pause-ms": { type: "string", default: "2000" },
  },
  strict: true,
});

const TOTAL_SESSIONS = Number(args.sessions);
const CONCURRENCY = Number(args.concurrency);
const WSS_URL = args.url!;
const API_KEY = args["api-key"]!;
const GREETING = args.greeting!;
const VOICE = args.voice!;
const TURNS = Number(args.turns);
const CHUNK_MS = Number(args["chunk-ms"]);
const PAUSE_MS = Number(args["pause-ms"]);
const INPUT_SAMPLE_RATE = 16_000;

if (!API_KEY) {
  console.error("Error: --api-key or $ASSEMBLYAI_API_KEY is required");
  process.exit(1);
}

// ── Tools & utterances ────────────────────────────────────────────────────────

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

// Suppress S2S client logging — we do our own.
const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// ── TTS generation ────────────────────────────────────────────────────────────

function resolveVoicesPath(): string {
  const require = createRequire(import.meta.url);
  return require.resolve("kokoro-js").replace(/dist.*/, "voices/");
}

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
    const val = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(i * 2, Math.round(val), true);
  }
  return new Uint8Array(buf);
}

type TTS = {
  generate(
    text: string,
    opts: { voice: string },
  ): Promise<{ audio: Float32Array; sampling_rate: number }>;
};

async function generateAudioBuffers(tts: TTS): Promise<Uint8Array[]> {
  const buffers: Uint8Array[] = [];
  for (let i = 0; i < UTTERANCES.length; i++) {
    const text = UTTERANCES[i]!;
    process.stdout.write(`  TTS [${i + 1}/${UTTERANCES.length}] "${text.slice(0, 50)}..." `);
    const result = await tts.generate(text, { voice: VOICE });
    const resampled = resample(result.audio, result.sampling_rate, INPUT_SAMPLE_RATE);
    const pcm = float32ToPcm16(resampled);
    console.log(`${(resampled.length / INPUT_SAMPLE_RATE).toFixed(2)}s (${pcm.length} bytes)`);
    buffers.push(pcm);
  }
  return buffers;
}

// ── Metrics ───────────────────────────────────────────────────────────────────

type ToolCallMetric = {
  turn: number;
  name: string;
  args: Record<string, unknown>;
};

type SessionMetrics = {
  sessionId: number;
  connected: boolean;
  sessionReady: boolean;
  turnsCompleted: number;
  userTranscripts: string[];
  agentTranscripts: string[];
  toolCalls: ToolCallMetric[];
  errors: string[];
  connectMs: number;
  firstGreetingMs: number;
  turnLatenciesMs: number[];
  totalMs: number;
};

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

function printMetrics(results: SessionMetrics[]): void {
  console.log("\n" + "=".repeat(70));
  console.log("RESULTS");
  console.log("=".repeat(70));

  for (const r of results) {
    console.log(`\n--- Session ${r.sessionId} ---`);
    console.log(`  Connected:        ${r.connected}`);
    console.log(`  Session ready:    ${r.sessionReady}`);
    console.log(`  Connect time:     ${r.connectMs}ms`);
    console.log(`  First greeting:   ${r.firstGreetingMs > 0 ? `${r.firstGreetingMs}ms` : "n/a"}`);
    console.log(`  Turns completed:  ${r.turnsCompleted}/${TURNS}`);
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
      console.log(
        `  Agent responses:  ${r.agentTranscripts.map((t) => `"${t.slice(0, 60)}${t.length > 60 ? "..." : ""}"`).join(", ")}`,
      );
    }
    if (r.errors.length > 0) {
      console.log(`  Errors:           ${r.errors.join("; ")}`);
    }
  }

  // Aggregate
  const succeeded = results.filter((r) => r.connected && r.sessionReady);
  const allLatencies = results.flatMap((r) => r.turnLatenciesMs).sort((a, b) => a - b);
  const greetingLatencies = results
    .map((r) => r.firstGreetingMs)
    .filter((l) => l > 0)
    .sort((a, b) => a - b);

  console.log("\n" + "=".repeat(70));
  console.log("AGGREGATE");
  console.log("=".repeat(70));
  console.log(`  Sessions:         ${results.length} total, ${succeeded.length} connected`);
  console.log(`  Total turns:      ${results.reduce((s, r) => s + r.turnsCompleted, 0)}`);
  console.log(`  Total tool calls: ${results.reduce((s, r) => s + r.toolCalls.length, 0)}`);
  if (greetingLatencies.length > 0) {
    console.log(`  Greeting p50:     ${percentile(greetingLatencies, 50)}ms`);
    console.log(`  Greeting p95:     ${percentile(greetingLatencies, 95)}ms`);
  }
  if (allLatencies.length > 0) {
    console.log(`  Turn latency p50: ${percentile(allLatencies, 50)}ms`);
    console.log(`  Turn latency p95: ${percentile(allLatencies, 95)}ms`);
    console.log(`  Turn latency p99: ${percentile(allLatencies, 99)}ms`);
  }

  // Errors section
  const allErrors = results.flatMap((r) =>
    r.errors.map((e) => ({ session: r.sessionId, error: e })),
  );
  const wsErrors = allErrors.filter((e) => e.error.startsWith("ws "));
  const apiErrors = allErrors.filter(
    (e) => e.error.startsWith("s2s error:") || e.error.startsWith("s2s expired:"),
  );
  const timeouts = allErrors.filter((e) => e.error.startsWith("session timeout"));
  const validationFails = allErrors.filter((e) => e.error.startsWith("FAIL:"));

  console.log("\n" + "=".repeat(70));
  console.log("ERRORS");
  console.log("=".repeat(70));
  if (allErrors.length === 0) {
    console.log("  (none)");
  } else {
    console.log(`  Total:            ${allErrors.length}`);
    if (wsErrors.length > 0) {
      console.log(`  WebSocket:        ${wsErrors.length}`);
      for (const e of wsErrors) console.log(`    [s${e.session}] ${e.error}`);
    }
    if (apiErrors.length > 0) {
      console.log(`  API:              ${apiErrors.length}`);
      for (const e of apiErrors) console.log(`    [s${e.session}] ${e.error}`);
    }
    if (timeouts.length > 0) {
      console.log(`  Timeouts:         ${timeouts.length}`);
      for (const e of timeouts) console.log(`    [s${e.session}] ${e.error}`);
    }
    if (validationFails.length > 0) {
      console.log(`  Validation:       ${validationFails.length}`);
      for (const e of validationFails) console.log(`    [s${e.session}] ${e.error}`);
    }
  }
}

// ── S2S session driver ────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSession(
  sessionId: number,
  audioBuffers: Uint8Array[],
): Promise<SessionMetrics> {
  const metrics: SessionMetrics = {
    sessionId,
    connected: false,
    sessionReady: false,
    turnsCompleted: 0,
    userTranscripts: [],
    agentTranscripts: [],
    toolCalls: [],
    errors: [],
    connectMs: 0,
    firstGreetingMs: 0,
    turnLatenciesMs: [],
    totalMs: 0,
  };

  const sessionStart = Date.now();
  let turnStart = 0;
  let currentTurn = 0;
  let waitingForReply = false;
  let greetingReceived = false;
  let gotAgentReplyThisTurn = false;
  let lastEvent = "init";
  let done = false;

  const log = (msg: string) => console.log(`  [s${sessionId}] ${msg}`);

  // Connect via SDK client
  let handle: S2sHandle;
  try {
    handle = await connectS2s({
      apiKey: API_KEY,
      config: { wssUrl: WSS_URL, inputSampleRate: INPUT_SAMPLE_RATE, outputSampleRate: 24_000 },
      createWebSocket: defaultCreateS2sWebSocket,
      logger: silentLogger,
    });
    metrics.connected = true;
    metrics.connectMs = Date.now() - sessionStart;
    log(`connected (${metrics.connectMs}ms)`);
  } catch (err: unknown) {
    const msg = `ws error: ${(err as Error).message}`;
    metrics.errors.push(msg);
    log(msg);
    metrics.totalMs = Date.now() - sessionStart;
    return metrics;
  }

  return new Promise((resolve) => {
    // ~30s per turn (pause + streaming + API processing) + 30s buffer for greeting
    const timeoutMs = TURNS * 30_000 + 30_000;
    const timeout = setTimeout(() => {
      const state = `turn=${currentTurn}/${TURNS}, greeting=${greetingReceived}, waitingForReply=${waitingForReply}, lastEvent=${lastEvent}`;
      const msg = `session timeout (${timeoutMs / 1000}s) [${state}]`;
      metrics.errors.push(msg);
      log(msg);
      finish();
    }, timeoutMs);

    function finish(): void {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      metrics.totalMs = Date.now() - sessionStart;

      if (metrics.connected && metrics.sessionReady && !greetingReceived) {
        const msg = "FAIL: no greeting received from agent";
        metrics.errors.push(msg);
        log(msg);
      }
      if (waitingForReply && currentTurn > 0) {
        const msg = `FAIL: turn ${currentTurn} got no agent reply`;
        metrics.errors.push(msg);
        log(msg);
      }
      const expectedReplies = metrics.turnsCompleted;
      const actualReplies = Math.max(
        0,
        metrics.agentTranscripts.length - (greetingReceived ? 1 : 0),
      );
      if (actualReplies < expectedReplies) {
        const msg = `FAIL: expected ${expectedReplies} agent replies but got ${actualReplies}`;
        metrics.errors.push(msg);
        log(msg);
      }

      handle.close();
      resolve(metrics);
    }

    handle.on("ready", ({ sessionId: sid }) => {
      metrics.sessionReady = true;
      lastEvent = "ready";
      log(`session ready (id: ${sid})`);
    });

    handle.on("sessionUpdated", () => {
      lastEvent = "sessionUpdated";
      log("session updated, waiting for greeting...");
    });

    handle.on("toolCall", ({ callId, name, args: toolArgs }) => {
      lastEvent = "toolCall";
      log(`tool call [turn ${currentTurn}]: ${name}(${JSON.stringify(toolArgs)})`);

      const responder = TOOL_RESPONSES[name];
      const result = responder
        ? responder(toolArgs)
        : JSON.stringify({ error: `unknown tool: ${name}` });
      handle.sendToolResult(callId, result);

      metrics.toolCalls.push({ turn: currentTurn, name, args: toolArgs });
      log(`tool result sent for ${name}`);
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
        const latency = Date.now() - turnStart;
        metrics.turnLatenciesMs.push(latency);
        log(`agent reply [turn ${currentTurn}]: "${text.slice(0, 60)}" (${latency}ms)`);
      }
    });

    handle.on("userTranscript", ({ text }) => {
      lastEvent = "userTranscript";
      metrics.userTranscripts.push(text);
      log(`user transcript [turn ${currentTurn}]: "${text}"`);
    });

    handle.on("replyDone", () => {
      lastEvent = "replyDone";

      // Tool calls produce intermediate reply.done events before the final
      // agent transcript. Only complete the turn when we got an actual
      // agentTranscript for it — otherwise this is a tool sub-reply.
      if (waitingForReply && gotAgentReplyThisTurn) {
        waitingForReply = false;
        gotAgentReplyThisTurn = false;
        metrics.turnsCompleted++;

        if (currentTurn < TURNS) {
          streamNextTurn();
        } else {
          log("all turns completed");
          finish();
        }
      } else if (!waitingForReply) {
        // Greeting reply done — start first turn
        if (currentTurn < TURNS) {
          streamNextTurn();
        }
      }
      // else: intermediate tool sub-reply, wait for agentTranscript + final replyDone
    });

    handle.on("error", ({ code, message }) => {
      metrics.errors.push(`s2s error: ${code} ${message}`);
      log(`error: ${code} ${message}`);
    });

    handle.on("sessionExpired", ({ code, message }) => {
      metrics.errors.push(`s2s expired: ${code} ${message}`);
      log(`session expired: ${code} ${message}`);
      finish();
    });

    handle.on("close", () => {
      log("ws closed");
      finish();
    });

    // Send session.update to kick off
    handle.updateSession({
      systemPrompt: SYSTEM_PROMPT,
      tools: TOOLS,
      greeting: GREETING,
    });

    async function streamNextTurn(): Promise<void> {
      currentTurn++;
      if (currentTurn > TURNS) return;

      await sleep(PAUSE_MS);
      if (done) return;

      const pcm = audioBuffers[(currentTurn - 1) % audioBuffers.length]!;
      const chunkBytes = Math.floor((INPUT_SAMPLE_RATE * CHUNK_MS) / 1000) * 2;

      log(
        `streaming turn ${currentTurn}/${TURNS} (${(pcm.length / (INPUT_SAMPLE_RATE * 2)).toFixed(2)}s)`,
      );
      waitingForReply = true;
      gotAgentReplyThisTurn = false;

      for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
        if (done) return;
        handle.sendAudio(pcm.slice(offset, offset + chunkBytes));
        await sleep(CHUNK_MS);
      }
      // Start latency timer after audio is fully sent — measures API processing
      // time (STT + LLM + tool calls + TTS) without streaming overhead.
      turnStart = Date.now();
      log(`turn ${currentTurn} audio sent, waiting for response...`);
    }
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("S2S Load Test");
  console.log("=".repeat(70));
  console.log(`  URL:         ${WSS_URL}`);
  console.log(`  Sessions:    ${TOTAL_SESSIONS}`);
  console.log(`  Concurrency: ${CONCURRENCY}`);
  console.log(`  Turns/sess:  ${TURNS}`);
  console.log(`  Chunk size:  ${CHUNK_MS}ms`);
  console.log(`  Pause:       ${PAUSE_MS}ms`);
  console.log(`  Voice:       ${VOICE}`);
  console.log(`  Greeting:    "${GREETING}"`);
  console.log(`  Tools:       ${TOOLS.map((t) => t.name).join(", ")}`);
  console.log();

  console.log("Generating TTS audio with Kokoro...");
  const { KokoroTTS } = await import("kokoro-js");
  const voicesPath = resolveVoicesPath();
  const tts = await KokoroTTS.from_pretrained(
    "onnx-community/Kokoro-82M-v1.0-ONNX",
    // @ts-expect-error voices_path is supported at runtime but missing from types
    { dtype: "q8", device: "cpu", voices_path: voicesPath },
  );
  const audioBuffers = await generateAudioBuffers(tts as unknown as TTS);
  console.log(`Generated ${audioBuffers.length} audio buffers\n`);

  console.log(
    `Running ${TOTAL_SESSIONS} session(s), ${CONCURRENCY} at a time...\n`,
  );
  const startTime = Date.now();

  // Worker pool: keep CONCURRENCY slots filled until all sessions are done
  const results: SessionMetrics[] = [];
  let nextId = 0;

  async function worker(): Promise<void> {
    while (nextId < TOTAL_SESSIONS) {
      const id = nextId++;
      const result = await runSession(id, audioBuffers);
      results.push(result);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, TOTAL_SESSIONS) }, () => worker()),
  );

  // Sort by session ID for stable output
  results.sort((a, b) => a.sessionId - b.sessionId);

  console.log(`\nAll sessions finished in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  printMetrics(results);

  const hasFailures = results.some((r) => r.errors.some((e) => e.startsWith("FAIL:")));
  process.exitCode = hasFailures ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
