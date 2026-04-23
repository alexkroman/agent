/**
 * Platform WebSocket load test — drives complete sessions against any
 * AAI platform WebSocket URL (wss://host/<slug>/websocket) by streaming
 * Kokoro TTS audio. Measures connect + turn latency, tool-call counts,
 * and error distribution.
 *
 * Usage:
 *   npx tsx scripts/platform-ws-load-test.ts --url <wss url> [options]
 *   npx tsx scripts/platform-ws-load-test.ts --help
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { defineCommand, runMain } from "citty";
import type { ServerMessage } from "../packages/aai/sdk/protocol.ts";
import { lenientParse, ServerMessageSchema } from "../packages/aai/sdk/protocol.ts";

// ── Config ───────────────────────────────────────────────────────────────────

type Config = {
  totalSessions: number;
  concurrency: number;
  wssUrl: string;
  voice: string;
  maxTurns: number;
  chunkMs: number;
  rampMs: number;
  greetingTimeoutMs: number;
  quiet: boolean;
};

const INPUT_SAMPLE_RATE = 16_000;
const MAX_RETRIES = 5;
const BARGE_IN_CHANCE = 0.2;

// ── Utterances ───────────────────────────────────────────────────────────────

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

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// ── TTS generation ───────────────────────────────────────────────────────────

type TTS = {
  generate(
    text: string,
    opts: { voice: string },
  ): Promise<{ audio: Float32Array; sampling_rate: number }>;
};

// ── WebSocket loader ─────────────────────────────────────────────────────────

// The `ws` package is a dep of packages/aai but not declared in scripts/;
// createRequire + require() resolves it through the pnpm hoist. Same pattern
// as scripts/s2s-load-test.ts.
const wsRequire = createRequire(import.meta.url);
const WsWebSocket = wsRequire("ws") as typeof import("ws").default;
type WsClient = InstanceType<typeof import("ws").default>;

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

/**
 * Pre-encodes audio into raw PCM16 byte chunks. Runs once at startup;
 * all sessions share the same frames. Unlike the S2S test, there is no
 * JSON wrapping — the platform WS sends raw bytes over binary frames.
 *
 * Returns outer[utterance][chunk] = Uint8Array of PCM16 bytes.
 */
async function generateAudioFrames(
  tts: TTS,
  voice: string,
  chunkMs: number,
): Promise<Uint8Array[][]> {
  const chunkBytes = Math.floor((INPUT_SAMPLE_RATE * chunkMs) / 1000) * 2;
  const frames: Uint8Array[][] = [];
  for (let i = 0; i < UTTERANCES.length; i++) {
    const text = UTTERANCES[i]!;
    process.stdout.write(`  TTS [${i + 1}/${UTTERANCES.length}] "${text.slice(0, 50)}..." `);
    const result = await tts.generate(text, { voice });
    const resampled = resample(result.audio, result.sampling_rate, INPUT_SAMPLE_RATE);
    const pcm = float32ToPcm16(resampled);
    const utteranceFrames: Uint8Array[] = [];
    for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
      utteranceFrames.push(pcm.subarray(offset, offset + chunkBytes));
    }
    console.log(
      `${(resampled.length / INPUT_SAMPLE_RATE).toFixed(2)}s (${pcm.length} bytes, ${utteranceFrames.length} chunks)`,
    );
    frames.push(utteranceFrames);
  }
  return frames;
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

function randomTurnCount(maxTurns: number): number {
  const r = Math.random();
  let turns: number;
  if (r < 0.10) turns = 1 + Math.floor(Math.random() * 2);
  else if (r < 0.25) turns = 3 + Math.floor(Math.random() * 2);
  else if (r < 0.50) turns = 5 + Math.floor(Math.random() * 3);
  else if (r < 0.75) turns = 8 + Math.floor(Math.random() * 3);
  else if (r < 0.90) turns = 11 + Math.floor(Math.random() * 4);
  else turns = 15 + Math.floor(Math.random() * 6);
  return Math.min(turns, maxTurns);
}

function randomPauseMs(): number {
  return 1000 + Math.floor(Math.random() * 5000);
}

function checkFdLimit(requiredFds: number): void {
  let hardLimit = -1;
  try {
    hardLimit = Number.parseInt(
      execFileSync("sh", ["-c", "ulimit -Hn"], { encoding: "utf8" }).trim(),
      10,
    );
  } catch {
    return;
  }
  if (!Number.isFinite(hardLimit) || hardLimit <= 0) return;
  if (hardLimit < requiredFds) {
    console.error(
      `Error: file descriptor hard limit too low (${hardLimit}, need ~${requiredFds}).`,
    );
    console.error(
      `Node auto-raises the soft limit to the hard limit at startup, but cannot exceed it.`,
    );
    console.error(
      `On macOS, raise the per-process cap:  sudo launchctl limit maxfiles ${Math.max(10_240, requiredFds * 2)} unlimited`,
    );
    console.error(
      `On Linux, run:                        ulimit -Hn ${Math.max(10_240, requiredFds * 2)}`,
    );
    process.exit(1);
  }
}

// ── Metrics types ────────────────────────────────────────────────────────────

type SessionMetrics = {
  sessionId: number;
  connected: boolean;
  configReceived: boolean;
  sandboxSessionId: string;
  greetingReceived: boolean;
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

// ── Session driver ───────────────────────────────────────────────────────────

async function runSession(
  sessionId: number,
  chunkFrames: Uint8Array[][],
  cfg: Config,
): Promise<SessionMetrics> {
  const sessionTurns = randomTurnCount(cfg.maxTurns);
  const bufferOrder = shuffle([...chunkFrames.keys()]);
  const log = cfg.quiet ? () => {} : (msg: string) => console.log(`  [s${sessionId}] ${msg}`);

  const metrics: SessionMetrics = {
    sessionId, connected: false, configReceived: false,
    sandboxSessionId: "", greetingReceived: false,
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
    const result = await runSessionAttempt(
      sessionId, sessionTurns, bufferOrder, chunkFrames, metrics, sessionStart, log, cfg,
    );
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
  chunkFrames: Uint8Array[][],
  metrics: SessionMetrics,
  sessionStart: number,
  log: (msg: string) => void,
  cfg: Config,
): Promise<"done" | "retry"> {
  const ws: WsClient = new WsWebSocket(cfg.wssUrl);
  ws.binaryType = "arraybuffer";

  return new Promise<"done" | "retry">((resolve) => {
    let currentTurn = metrics.turnsCompleted;
    let waitingForReply = false;
    let greetingReceived = metrics.greetingReceived;
    let recordedLatencyThisTurn = false;
    let turnStart = 0;
    let bargeInScheduled = false;
    let lastEvent = "init";
    let done = false;
    let shouldRetry = false;

    let silenceTimer: NodeJS.Timeout | null = null;
    let silenceWaiters: Array<() => void> = [];

    function markSilent(): void {
      silenceTimer = null;
      const waiters = silenceWaiters;
      silenceWaiters = [];
      for (const w of waiters) w();
    }
    function onAudioTick(): void {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(markSilent, 500);
    }
    function waitForSilence(): Promise<void> {
      if (silenceTimer === null) return Promise.resolve();
      return new Promise((resolve) => silenceWaiters.push(resolve));
    }

    const timeoutMs = sessionTurns * 30_000 + 30_000;
    const sessionTimeout = setTimeout(() => {
      const state = `turn=${currentTurn}/${sessionTurns}, greeting=${greetingReceived}, waitingForReply=${waitingForReply}, lastEvent=${lastEvent}`;
      metrics.errors.push(`session timeout (${timeoutMs / 1000}s) [${state}]`);
      log(`session timeout [${state}]`);
      finish();
    }, timeoutMs);

    const connectTimer = setTimeout(() => {
      if (!metrics.configReceived) {
        metrics.errors.push("no config within 10s");
        log("no config within 10s");
        shouldRetry = true;
        finish();
      }
    }, 10_000);

    let greetingTimer: NodeJS.Timeout | null = null;

    function finish(): void {
      if (done) return;
      done = true;
      clearTimeout(connectTimer);
      clearTimeout(sessionTimeout);
      if (greetingTimer) { clearTimeout(greetingTimer); greetingTimer = null; }
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      const waiters = silenceWaiters;
      silenceWaiters = [];
      for (const w of waiters) w();

      if (waitingForReply && currentTurn > 0) {
        metrics.errors.push(`FAIL: turn ${currentTurn} got no agent reply`);
      }
      if (metrics.connected && !metrics.configReceived) {
        metrics.errors.push("FAIL: no config received");
      }
      try { ws.close(); } catch {}
      resolve(shouldRetry ? "retry" : "done");
    }

    ws.on("open", () => {
      metrics.connected = true;
      log("ws open");
    });

    ws.on("close", () => {
      log("ws closed");
      if (!done && metrics.turnsCompleted < sessionTurns) shouldRetry = true;
      finish();
    });

    ws.on("error", (err: Error) => {
      metrics.errors.push(`ws error: ${err.message}`);
      log(`ws error: ${err.message}`);
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        onAudioTick();
        if (currentTurn > 0 && waitingForReply && !recordedLatencyThisTurn && turnStart > 0) {
          recordedLatencyThisTurn = true;
          const latency = Date.now() - turnStart;
          metrics.turnLatenciesMs.push(latency);
          log(`first agent audio [turn ${currentTurn}]: ${latency}ms`);
        }
        if (currentTurn > 0 && waitingForReply && bargeInScheduled && !done) {
          bargeInScheduled = false;
          metrics.bargeIns++;
          log(`barge-in [turn ${currentTurn}]`);
          const bufIdx = bufferOrder[currentTurn % bufferOrder.length]!;
          const frames = chunkFrames[bufIdx]!;
          for (let i = 0; i < Math.min(frames.length, 5); i++) {
            if (ws.readyState === ws.OPEN) ws.send(frames[i]!);
          }
        }
        return;
      }
      const text = data instanceof Buffer ? data.toString("utf8") : String(data);
      let json: unknown;
      try { json = JSON.parse(text); } catch { return; }
      const parsed = lenientParse(ServerMessageSchema, json);
      if (!parsed.ok) return;
      handleServerMessage(parsed.data);
    });

    function handleServerMessage(msg: ServerMessage): void {
      switch (msg.type) {
        case "config":
          metrics.configReceived = true;
          metrics.connectMs = Date.now() - sessionStart;
          metrics.sandboxSessionId = msg.sessionId ?? "";
          clearTimeout(connectTimer);
          lastEvent = "config";
          log(`config received (sessionId=${metrics.sandboxSessionId || "—"}, ${metrics.connectMs}ms)`);
          ws.send(JSON.stringify({ type: "audio_ready" }));
          greetingTimer = setTimeout(() => {
            greetingTimer = null;
            if (!greetingReceived && !done) {
              log(`no greeting within ${cfg.greetingTimeoutMs}ms — starting turn 1`);
              void streamNextTurn();
            }
          }, cfg.greetingTimeoutMs);
          break;
        case "speech_started":
          lastEvent = "speech_started";
          break;
        case "speech_stopped":
          lastEvent = "speech_stopped";
          if (waitingForReply) {
            turnStart = Date.now();
            log(`turn ${currentTurn} speech_stopped; waiting for reply`);
          }
          break;
        case "user_transcript":
          lastEvent = "user_transcript";
          metrics.userTranscripts.push(msg.text);
          break;
        case "agent_transcript":
          lastEvent = "agent_transcript";
          metrics.agentTranscripts.push(msg.text);
          if (currentTurn === 0 && !greetingReceived) {
            greetingReceived = true;
            metrics.greetingReceived = true;
            metrics.firstGreetingMs = Date.now() - sessionStart;
            if (greetingTimer) { clearTimeout(greetingTimer); greetingTimer = null; }
            log(`greeting: "${msg.text.slice(0, 60)}" (${metrics.firstGreetingMs}ms)`);
          }
          break;
        case "tool_call":
          lastEvent = "tool_call";
          metrics.toolCalls.push({ turn: currentTurn, name: msg.toolName, args: msg.args });
          break;
        case "tool_call_done":
          lastEvent = "tool_call_done";
          break;
        case "audio_done":
          lastEvent = "audio_done";
          onAudioTick();
          break;
        case "reply_done":
          lastEvent = "reply_done";
          waitingForReply = false;
          recordedLatencyThisTurn = false;
          if (currentTurn > 0) metrics.turnsCompleted++;
          log(`reply_done (turn ${currentTurn}/${sessionTurns})`);
          if (currentTurn < sessionTurns) void streamNextTurn();
          else if (currentTurn > 0) finish();
          break;
        case "cancelled":
          lastEvent = "cancelled";
          waitingForReply = false;
          recordedLatencyThisTurn = false;
          if (currentTurn < sessionTurns) void streamNextTurn();
          else if (currentTurn > 0) finish();
          break;
        case "idle_timeout":
          lastEvent = "idle_timeout";
          metrics.errors.push("idle_timeout");
          shouldRetry = true;
          finish();
          break;
        case "error":
          lastEvent = `error[${msg.code}]`;
          metrics.errors.push(`[${msg.code}] ${msg.message}`);
          break;
        default:
          break;
      }
    }

    async function streamNextTurn(): Promise<void> {
      currentTurn++;
      if (currentTurn > sessionTurns) return;
      bargeInScheduled = Math.random() < BARGE_IN_CHANCE;
      await waitForSilence();
      if (done) return;
      await sleep(randomPauseMs());
      if (done) return;
      const bufIdx = bufferOrder[(currentTurn - 1) % bufferOrder.length]!;
      const frames = chunkFrames[bufIdx]!;
      const approxSec = (frames.length * cfg.chunkMs) / 1000;
      log(
        `streaming turn ${currentTurn}/${sessionTurns}${bargeInScheduled ? " (will barge-in)" : ""} (${approxSec.toFixed(2)}s)`,
      );
      waitingForReply = true;
      recordedLatencyThisTurn = false;
      turnStart = 0;
      for (const frame of frames) {
        if (done) return;
        if (ws.readyState !== ws.OPEN) return;
        ws.send(frame);
        await sleep(cfg.chunkMs);
      }
    }
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(cfg: Config): Promise<void> {
  console.log("Platform WebSocket Load Test");
  console.log("=".repeat(70));
  console.log(`  URL:         ${cfg.wssUrl}`);
  console.log(`  Sessions:    ${cfg.totalSessions}`);
  console.log(`  Concurrency: ${cfg.concurrency}`);
  console.log(`  Max turns:   ${cfg.maxTurns}`);
  console.log(`  Chunk size:  ${cfg.chunkMs}ms`);
  console.log(`  Ramp-up:     ${cfg.rampMs > 0 ? `${cfg.rampMs}ms` : "off"}`);
  console.log(`  Voice:       ${cfg.voice}`);
  console.log();

  console.log("Generating TTS audio with Kokoro...");
  const { KokoroTTS } = await import("kokoro-js");
  const require = createRequire(import.meta.url);
  const voicesPath = require.resolve("kokoro-js").replace(/dist.*/, "voices/");
  const tts = await KokoroTTS.from_pretrained(
    "onnx-community/Kokoro-82M-v1.0-ONNX",
    // @ts-expect-error voices_path is supported at runtime but missing from types
    { dtype: "q8", device: "cpu", voices_path: voicesPath },
  );
  const chunkFrames = await generateAudioFrames(tts as unknown as TTS, cfg.voice, cfg.chunkMs);
  console.log(`Generated ${chunkFrames.length} utterances (pre-encoded frames)\n`);

  console.log(`Running 1 session (Task 4: metrics smoke test)...\n`);
  const result = await runSession(0, chunkFrames, cfg);
  console.log("\n" + JSON.stringify(result, null, 2));
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const loadTestCommand = defineCommand({
  meta: {
    name: "platform-ws-load-test",
    description: "Platform WebSocket load test — drives sessions against any AAI platform URL.",
  },
  args: {
    url: { type: "string", description: "Platform WebSocket URL (wss://host/<slug>/websocket)", required: true },
    sessions: { type: "string", alias: "n", description: "Total number of sessions to run", default: "100" },
    concurrency: { type: "string", alias: "c", description: "Max simultaneous sessions", default: "25" },
    turns: { type: "string", description: "Max user turns per session (randomized, avg ~8)", default: "20" },
    chunkMs: { type: "string", description: "Audio chunk size in ms", default: "100" },
    rampMs: { type: "string", description: "Stagger session starts over this many ms", default: "30000" },
    voice: { type: "string", description: "Kokoro voice preset", default: "af_heart" },
    greetingTimeoutMs: { type: "string", description: "Wait this long for optional agent greeting", default: "3000" },
    verbose: { type: "boolean", alias: "v", description: "Show per-session event logs", default: false },
  },
  async run({ args }) {
    if (args.verbose && Number(args.concurrency) > 100) {
      console.error(
        "Error: --verbose with concurrency > 100 produces enough stdout to " +
          "dominate event-loop time and skew results. Drop --verbose, or lower -c.",
      );
      process.exit(1);
    }
    checkFdLimit(Math.max(3000, Number(args.sessions) + 500));
    await main({
      totalSessions: Number(args.sessions),
      concurrency: Number(args.concurrency),
      wssUrl: args.url,
      voice: args.voice,
      maxTurns: Number(args.turns),
      chunkMs: Number(args.chunkMs),
      rampMs: Number(args.rampMs),
      greetingTimeoutMs: Number(args.greetingTimeoutMs),
      quiet: !args.verbose,
    });
  },
});

runMain(loadTestCommand);
