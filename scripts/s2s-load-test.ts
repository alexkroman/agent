/**
 * S2S API load test — drives complete sessions by streaming Kokoro TTS audio.
 * Includes tool calling: registers tools in the session and responds to tool.call
 * messages from the agent with mock tool.result responses.
 *
 * Usage:
 *   npx tsx scripts/s2s-load-test.ts [options]
 *
 * Options:
 *   --concurrency, -c   Number of concurrent sessions (default: 1)
 *   --url               S2S WebSocket URL (default: wss://speech-to-speech.us.assemblyai.com/v1/realtime)
 *   --api-key           AssemblyAI API key (default: $ASSEMBLYAI_API_KEY)
 *   --greeting          Agent greeting text (default: "Hello, how can I help?")
 *   --voice             Kokoro voice preset (default: af_heart)
 *   --turns             Number of user turns per session (default: 3)
 *   --chunk-ms          Audio chunk size in ms when streaming (default: 100)
 *   --pause-ms          Pause between turns in ms (default: 2000)
 */

import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import WebSocket from "ws";

// ── CLI args ──────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
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

// Tools registered with the S2S session. The system prompt instructs the agent
// to use them, so most turns should trigger at least one tool call.
const TOOLS = [
  {
    type: "function" as const,
    name: "get_weather",
    description: "Get the current weather for a location.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "City name" },
      },
      required: ["location"],
    },
  },
  {
    type: "function" as const,
    name: "search_web",
    description: "Search the web for information.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
  },
  {
    type: "function" as const,
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
    type: "function" as const,
    name: "get_store_hours",
    description: "Get store hours for a given day of the week.",
    parameters: {
      type: "object",
      properties: {
        day: { type: "string", description: "Day of the week" },
      },
      required: ["day"],
    },
  },
];

/** Mock responses keyed by tool name. */
const TOOL_RESPONSES: Record<string, (args: Record<string, unknown>) => string> = {
  get_weather: (a) =>
    JSON.stringify({ temperature: "72F", condition: "sunny", location: a.location ?? "unknown" }),
  search_web: (a) =>
    JSON.stringify({
      results: [
        { title: `Result for: ${a.query}`, snippet: "Here is some useful information." },
      ],
    }),
  book_appointment: (a) =>
    JSON.stringify({ confirmed: true, date: a.date, time: a.time, name: a.name }),
  get_store_hours: (a) =>
    JSON.stringify({ day: a.day, open: "9:00 AM", close: "9:00 PM" }),
};

// Utterances designed to trigger tool calls.
const UTTERANCES = [
  "What's the weather like in San Francisco right now?",
  "Can you search the web for the best Italian restaurants nearby?",
  "I'd like to book an appointment for tomorrow at 2 PM, my name is Alex.",
  "What time does the store close on Saturday?",
  "What's the weather in New York today?",
  "Search for how to make sourdough bread.",
  "Book me an appointment next Monday at 10 AM, name is Jordan.",
  "What are the store hours on Sunday?",
];

const SYSTEM_PROMPT = `You are a helpful voice assistant. Keep responses brief — one or two sentences.
You MUST use the provided tools to answer questions. Always call the appropriate tool before responding.
- For weather questions, use get_weather.
- For general knowledge or search questions, use search_web.
- For booking requests, use book_appointment.
- For store hours questions, use get_store_hours.`;

// ── TTS generation ────────────────────────────────────────────────────────────

/** Resolve the kokoro-js voices/ directory from the installed package. */
function resolveVoicesPath(): string {
  const require = createRequire(import.meta.url);
  return require.resolve("kokoro-js").replace(/dist.*/, "voices/");
}

/** Downsample Float32 audio from srcRate to dstRate via linear interpolation. */
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

/** Convert Float32 [-1,1] to 16-bit signed PCM little-endian. */
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
    const durationSec = resampled.length / INPUT_SAMPLE_RATE;
    console.log(`${durationSec.toFixed(2)}s (${pcm.length} bytes)`);
    buffers.push(pcm);
  }
  return buffers;
}

// ── Metrics ───────────────────────────────────────────────────────────────────

type ToolCallMetric = {
  turn: number;
  name: string;
  args: Record<string, unknown>;
  responseMs: number;
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
    console.log(
      `  First greeting:   ${r.firstGreetingMs > 0 ? `${r.firstGreetingMs}ms` : "n/a"}`,
    );
    console.log(`  Turns completed:  ${r.turnsCompleted}/${TURNS}`);
    if (r.turnLatenciesMs.length > 0) {
      console.log(
        `  Turn latencies:   ${r.turnLatenciesMs.map((l) => `${l}ms`).join(", ")}`,
      );
    }
    console.log(`  Tool calls:       ${r.toolCalls.length}`);
    for (const tc of r.toolCalls) {
      console.log(
        `    [turn ${tc.turn}] ${tc.name}(${JSON.stringify(tc.args)}) -> responded in ${tc.responseMs}ms`,
      );
    }
    console.log(`  Total time:       ${r.totalMs}ms`);
    if (r.userTranscripts.length > 0) {
      console.log(
        `  User transcripts: ${r.userTranscripts.map((t) => `"${t}"`).join(", ")}`,
      );
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
  const allLatencies = results
    .flatMap((r) => r.turnLatenciesMs)
    .sort((a, b) => a - b);
  const greetingLatencies = results
    .map((r) => r.firstGreetingMs)
    .filter((l) => l > 0)
    .sort((a, b) => a - b);
  const totalToolCalls = results.reduce((s, r) => s + r.toolCalls.length, 0);

  console.log("\n" + "=".repeat(70));
  console.log("AGGREGATE");
  console.log("=".repeat(70));
  console.log(
    `  Sessions:         ${results.length} total, ${succeeded.length} connected`,
  );
  console.log(
    `  Total turns:      ${results.reduce((s, r) => s + r.turnsCompleted, 0)}`,
  );
  console.log(`  Total tool calls: ${totalToolCalls}`);
  const allErrors = results.flatMap((r) => r.errors);
  const failures = allErrors.filter((e) => e.startsWith("FAIL:"));
  console.log(`  Total errors:     ${allErrors.length}`);
  if (failures.length > 0) {
    console.log(`  Validation fails: ${failures.length}`);
    for (const f of failures) {
      console.log(`    - ${f}`);
    }
  }

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

// ── S2S session driver ────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runSession(
  sessionId: number,
  audioBuffers: Uint8Array[],
): Promise<SessionMetrics> {
  return new Promise((resolve) => {
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
    let agentRepliedThisTurn = false;
    let done = false;

    function finish(): void {
      if (done) return;
      done = true;
      metrics.totalMs = Date.now() - sessionStart;

      // Validate: greeting must have been received
      if (metrics.connected && metrics.sessionReady && !greetingReceived) {
        const msg = "FAIL: no greeting received from agent";
        metrics.errors.push(msg);
        log(msg);
      }

      // Validate: if we started a turn but got no agent reply
      if (waitingForReply && currentTurn > 0) {
        const msg = `FAIL: turn ${currentTurn} got no agent reply`;
        metrics.errors.push(msg);
        log(msg);
      }

      // Validate: every completed turn should have an agent transcript
      // agentTranscripts[0] is the greeting, so turns start at index 1
      const expectedReplies = metrics.turnsCompleted;
      const actualReplies = Math.max(0, metrics.agentTranscripts.length - (greetingReceived ? 1 : 0));
      if (actualReplies < expectedReplies) {
        const msg = `FAIL: expected ${expectedReplies} agent replies but got ${actualReplies}`;
        metrics.errors.push(msg);
        log(msg);
      }

      try {
        ws.close();
      } catch {}
      resolve(metrics);
    }

    // Timeout: 2 min per session max
    const timeout = setTimeout(() => {
      metrics.errors.push("session timeout (120s)");
      finish();
    }, 120_000);

    const log = (msg: string) => console.log(`  [s${sessionId}] ${msg}`);

    const ws = new WebSocket(WSS_URL, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

    ws.on("open", () => {
      metrics.connected = true;
      metrics.connectMs = Date.now() - sessionStart;
      log(`connected (${metrics.connectMs}ms)`);

      // Send session.update with tools
      ws.send(
        JSON.stringify({
          type: "session.update",
          session: {
            system_prompt: SYSTEM_PROMPT,
            greeting: GREETING,
            tools: TOOLS,
          },
        }),
      );
    });

    ws.on("message", (data: Buffer) => {
      let msg: { type: string; [k: string]: unknown };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      switch (msg.type) {
        case "session.ready":
          metrics.sessionReady = true;
          log(`session ready (id: ${msg.session_id})`);
          break;

        case "session.updated":
          log("session updated, waiting for greeting...");
          break;

        case "tool.call": {
          const callId = msg.call_id as string;
          const name = msg.name as string;
          const toolArgs = (msg.args as Record<string, unknown>) ?? {};
          log(`tool call [turn ${currentTurn}]: ${name}(${JSON.stringify(toolArgs)})`);

          const callStart = Date.now();

          // Generate mock tool response
          const responder = TOOL_RESPONSES[name];
          const result = responder
            ? responder(toolArgs)
            : JSON.stringify({ error: `unknown tool: ${name}` });

          // Send tool.result back
          ws.send(
            JSON.stringify({
              type: "tool.result",
              call_id: callId,
              result,
            }),
          );

          metrics.toolCalls.push({
            turn: currentTurn,
            name,
            args: toolArgs,
            responseMs: Date.now() - callStart,
          });
          log(`tool result sent for ${name} (call_id: ${callId})`);
          break;
        }

        case "transcript.agent": {
          const text = msg.text as string;
          metrics.agentTranscripts.push(text);

          if (!greetingReceived) {
            greetingReceived = true;
            metrics.firstGreetingMs = Date.now() - sessionStart;
            log(
              `greeting: "${text.slice(0, 60)}" (${metrics.firstGreetingMs}ms)`,
            );
          } else if (waitingForReply) {
            const latency = Date.now() - turnStart;
            metrics.turnLatenciesMs.push(latency);
            log(
              `agent reply [turn ${currentTurn}]: "${text.slice(0, 60)}" (${latency}ms)`,
            );
          }
          break;
        }

        case "transcript.user": {
          const text = msg.text as string;
          metrics.userTranscripts.push(text);
          log(`user transcript [turn ${currentTurn}]: "${text}"`);
          break;
        }

        case "reply.done":
          if (waitingForReply) {
            waitingForReply = false;
            metrics.turnsCompleted++;
          }

          // After greeting or a completed turn, start next turn
          if (currentTurn < TURNS) {
            streamNextTurn();
          } else {
            log("all turns completed");
            clearTimeout(timeout);
            finish();
          }
          break;

        case "session.error":
        case "error":
          metrics.errors.push(`${msg.type}: ${msg.message ?? msg.code}`);
          log(`error: ${msg.message ?? msg.code}`);
          break;
      }
    });

    ws.on("error", (err: Error) => {
      metrics.errors.push(`ws error: ${err.message}`);
      log(`ws error: ${err.message}`);
      clearTimeout(timeout);
      finish();
    });

    ws.on("close", () => {
      log("ws closed");
      clearTimeout(timeout);
      finish();
    });

    async function streamNextTurn(): Promise<void> {
      currentTurn++;
      if (currentTurn > TURNS) return;

      await sleep(PAUSE_MS);
      if (done) return;

      const audioIdx = (currentTurn - 1) % audioBuffers.length;
      const pcm = audioBuffers[audioIdx]!;
      const chunkBytes = Math.floor((INPUT_SAMPLE_RATE * CHUNK_MS) / 1000) * 2; // 2 bytes per sample
      const totalChunks = Math.ceil(pcm.length / chunkBytes);

      log(
        `streaming turn ${currentTurn}/${TURNS} (${(pcm.length / (INPUT_SAMPLE_RATE * 2)).toFixed(2)}s, ${totalChunks} chunks)`,
      );
      turnStart = Date.now();
      waitingForReply = true;

      for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
        if (done) return;
        const chunk = pcm.slice(offset, offset + chunkBytes);
        const b64 = Buffer.from(chunk).toString("base64");
        ws.send(JSON.stringify({ type: "input.audio", audio: b64 }));
        // Pace audio at roughly real-time
        await sleep(CHUNK_MS);
      }
      log(`turn ${currentTurn} audio sent, waiting for response...`);
    }
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("S2S Load Test");
  console.log("=".repeat(70));
  console.log(`  URL:         ${WSS_URL}`);
  console.log(`  Concurrency: ${CONCURRENCY}`);
  console.log(`  Turns/sess:  ${TURNS}`);
  console.log(`  Chunk size:  ${CHUNK_MS}ms`);
  console.log(`  Pause:       ${PAUSE_MS}ms`);
  console.log(`  Voice:       ${VOICE}`);
  console.log(`  Greeting:    "${GREETING}"`);
  console.log(`  Tools:       ${TOOLS.map((t) => t.name).join(", ")}`);
  console.log();

  // Generate TTS audio fresh each run
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

  // Launch concurrent sessions
  console.log(`Launching ${CONCURRENCY} concurrent session(s)...\n`);
  const startTime = Date.now();

  const promises: Promise<SessionMetrics>[] = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    promises.push(runSession(i, audioBuffers));
  }
  const results = await Promise.all(promises);

  const elapsed = Date.now() - startTime;
  console.log(`\nAll sessions finished in ${(elapsed / 1000).toFixed(1)}s`);

  printMetrics(results);

  // Exit with failure if any validation errors
  const hasFailures = results.some((r) => r.errors.some((e) => e.startsWith("FAIL:")));
  if (hasFailures) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
