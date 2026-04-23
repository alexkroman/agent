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

// ── Session driver ───────────────────────────────────────────────────────────

async function runSession(
  sessionId: number,
  chunkFrames: Uint8Array[][],
  cfg: Config,
): Promise<void> {
  const log = cfg.quiet ? () => {} : (msg: string) => console.log(`  [s${sessionId}] ${msg}`);
  const ws: WsClient = new WsWebSocket(cfg.wssUrl);
  ws.binaryType = "arraybuffer";

  return new Promise<void>((resolve) => {
    let configReceived = false;
    let done = false;

    function finish(reason: string): void {
      if (done) return;
      done = true;
      log(`finish: ${reason}`);
      try { ws.close(); } catch {}
      resolve();
    }

    const connectTimer = setTimeout(() => {
      if (!configReceived) finish("no config within 10s");
    }, 10_000);

    ws.on("open", () => log("ws open"));

    ws.on("close", () => {
      clearTimeout(connectTimer);
      finish("ws close");
    });

    ws.on("error", (err: Error) => {
      log(`ws error: ${err.message}`);
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        // Binary frame = TTS audio chunk from agent. Count only.
        return;
      }
      const text = data instanceof Buffer ? data.toString("utf8") : String(data);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        log(`invalid JSON: ${text.slice(0, 80)}`);
        return;
      }
      const parsed = lenientParse(ServerMessageSchema, json);
      if (!parsed.ok) {
        if (parsed.malformed) log(`malformed message: ${parsed.error}`);
        return;
      }
      const msg: ServerMessage = parsed.data;
      handleServerMessage(msg);
    });

    async function handleServerMessage(msg: ServerMessage): Promise<void> {
      switch (msg.type) {
        case "config":
          configReceived = true;
          clearTimeout(connectTimer);
          log(`config received (sessionId=${msg.sessionId ?? "—"}) sending audio_ready`);
          ws.send(JSON.stringify({ type: "audio_ready" }));
          void streamOneTurn();
          break;
        case "speech_started":
          log("speech_started");
          break;
        case "speech_stopped":
          log("speech_stopped");
          break;
        case "user_transcript":
          log(`user_transcript: "${msg.text}"`);
          break;
        case "agent_transcript":
          log(`agent_transcript: "${msg.text.slice(0, 60)}"`);
          break;
        case "tool_call":
          log(`tool_call: ${msg.toolName}(${JSON.stringify(msg.args)})`);
          break;
        case "tool_call_done":
          log(`tool_call_done: ${msg.toolCallId}`);
          break;
        case "audio_done":
          log("audio_done");
          break;
        case "reply_done":
          log("reply_done");
          finish("reply_done");
          break;
        case "error":
          log(`error[${msg.code}]: ${msg.message}`);
          break;
        default:
          break;
      }
    }

    async function streamOneTurn(): Promise<void> {
      await sleep(500); // small settle before streaming
      const frames = chunkFrames[0]!; // use first utterance
      log(`streaming ${frames.length} frames`);
      for (const frame of frames) {
        if (done) return;
        if (ws.readyState !== ws.OPEN) return;
        ws.send(frame);
        await sleep(cfg.chunkMs);
      }
      log("stream done; waiting for reply_done");
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

  console.log(`Running 1 session (Task 2: single-turn smoke test)...\n`);
  await runSession(0, chunkFrames, cfg);
  console.log("\nSession finished.");
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
