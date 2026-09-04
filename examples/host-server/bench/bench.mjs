// Concurrency benchmark for the host server: how many simultaneous voice
// sessions one process holds, and where it stops keeping up.
//
//   node bench.mjs [--steps 25,50,100,200] [--hold 12] [--frame-ms 20]
//
// Each simulated tenant does what a real one does: opens `?host=1`, sends its
// agent in the config frame, then streams 16 kHz PCM16 continuously and reads
// the agent's audio back. The server's providers point at local fakes, so
// everything above the provider socket is real code.
//
// Read the caveats in bench/README.md before quoting a number: the driver
// shares this machine with the server (and saturates a core near 1000
// sessions), and the fakes are on loopback, so provider RTT is absent.

import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeCert, startFakeStt, startFakeTts } from "./fakes.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const STEPS = String(arg("steps", "25,50,100,200,400")).split(",").map(Number);
const HOLD_S = Number(arg("hold", 12));
const FRAME_MS = Number(arg("frame-ms", 20));
const SAMPLE_RATE = 16_000;
const PORT = Number(arg("port", 8787));

// One shared buffer for every sender: generating per-connection audio would
// make the driver, not the server, the thing under test.
const FRAME = Buffer.alloc((SAMPLE_RATE / 1000) * FRAME_MS * 2);

function readProc(pid) {
  const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
  const rssKb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
  const fields = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(" ");
  const ticks = Number(fields[13]) + Number(fields[14]);
  const fds = fs.readdirSync(`/proc/${pid}/fd`).length;
  return { rssKb, ticks, fds };
}

const HZ = 100; // Linux USER_HZ

function pct(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);
}

/** One simulated tenant. Resolves once the session is ready to stream. */
function openSession(port) {
  const started = Date.now();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/websocket?host=1`);
  /** @type {{ ws: WebSocket, ready: boolean, audioBytes: number, readyMs: number, error: string | null }} */
  const state = { ws, ready: false, audioBytes: 0, readyMs: 0, error: null };
  return new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve(state);
    };
    ws.binaryType = "arraybuffer";
    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          type: "config",
          host: {
            systemPrompt: "You are a benchmark agent.",
            greeting: "Hello, this is the benchmark greeting.",
            tools: [],
            credentials: { ASSEMBLYAI_API_KEY: "sk-bench" },
          },
          sampleRate: SAMPLE_RATE,
          ttsSampleRate: SAMPLE_RATE,
        }),
      );
    });
    ws.addEventListener("message", (e) => {
      if (typeof e.data !== "string") {
        state.audioBytes += e.data.byteLength;
        return;
      }
      const msg = JSON.parse(e.data);
      // The ready `config` frame is the server saying the session exists.
      if (msg.type === "config" && !state.ready) {
        state.ready = true;
        state.readyMs = Date.now() - started;
        settle();
      }
      if (msg.type === "error") {
        state.error ??= `${msg.code}: ${msg.message}`;
        settle();
      }
    });
    ws.addEventListener("error", () => {
      state.error ??= "socket error";
      settle();
    });
    ws.addEventListener("close", () => {
      state.error ??= "closed";
      settle();
    });
  });
}

const sessions = [];

/**
 * Open in small batches rather than all at once. Tenants arrive over time;
 * a thundering herd of N simultaneous upgrades measures connect burst
 * handling, which is a different question from steady-state capacity (and it
 * dominated `ready p95` — 2.3s at 400-at-once vs 0.4s paced).
 */
async function rampTo(target, port) {
  const BATCH = 25;
  while (sessions.length < target) {
    const opening = [];
    const n = Math.min(BATCH, target - sessions.length);
    for (let i = 0; i < n; i++) opening.push(openSession(port));
    for (const s of await Promise.all(opening)) sessions.push(s);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function main() {
  const cert = makeCert();
  const stt = await startFakeStt({ key: cert.key, cert: cert.cert });
  const tts = await startFakeTts({ key: cert.key, cert: cert.cert, sampleRate: SAMPLE_RATE });

  const child = fork(path.join(here, "server.mjs"), {
    env: {
      ...process.env,
      BENCH_STT_URL: stt.url(),
      BENCH_TTS_HOST: tts.host(),
      BENCH_PORT: String(PORT),
      // The fake TTS is wss with a self-signed cert; trust it alongside
      // whatever CA bundle the environment already needs.
      NODE_EXTRA_CA_CERTS: cert.cert,
    },
    stdio: ["ignore", "pipe", "inherit", "ipc"],
  });

  let lagMax = 0;
  // `stdio` above asks for a pipe, so this is never null — but `spawn`'s type
  // cannot know that, and the assertion is the one place to say so.
  const childOut = child.stdout;
  if (childOut === null) throw new Error("bench: child was spawned without a stdout pipe");
  childOut.setEncoding("utf8");
  childOut.on("data", (chunk) => {
    for (const line of chunk.trim().split("\n")) {
      if (line === "ready") return;
      try {
        lagMax = Math.max(lagMax, JSON.parse(line).lagMax);
      } catch {
        /* not a stats line */
      }
    }
  });

  await new Promise((r) => setTimeout(r, 1500));

  const baseline = readProc(child.pid);
  console.log(`server pid ${child.pid} · baseline RSS ${(baseline.rssKb / 1024).toFixed(1)} MiB\n`);
  console.log(
    "  conns   ready  RSS MiB  KiB/conn   CPU%  drvCPU  loop lag  ready p50/p95   audio in/out",
  );
  console.log(`  ${"─".repeat(84)}`);

  // One shared timer drives every sender: thousands of per-connection timers
  // would measure the driver's scheduler, not the server.
  const sender = setInterval(() => {
    for (const s of sessions) {
      if (s.ready && s.ws.readyState === 1) s.ws.send(FRAME);
    }
  }, FRAME_MS);

  for (const target of STEPS) {
    await rampTo(target, PORT);
    const live = sessions.filter((s) => s.ready && !s.error);
    if (live.length === 0) {
      console.log(`  ${String(target).padStart(5)}   none ready — stopping`);
      console.log(`  errors: ${[...new Set(sessions.map((s) => s.error))].join(" | ")}`);
      break;
    }

    lagMax = 0;
    const before = readProc(child.pid);
    const driverBefore = readProc(process.pid);
    const sttBefore = stt.stats().audioBytes;
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, HOLD_S * 1000));
    const after = readProc(child.pid);
    const driverAfter = readProc(process.pid);
    const elapsed = (Date.now() - t0) / 1000;

    const cpu = (((after.ticks - before.ticks) / HZ) * 100) / elapsed;
    // The driver shares these 4 cores. Once it saturates a core, the ramp is
    // measuring the harness, not the server — so it is reported, not hidden.
    const driverCpu = (((driverAfter.ticks - driverBefore.ticks) / HZ) * 100) / elapsed;
    const perConn = (after.rssKb - baseline.rssKb) / live.length;
    const readyMs = live.map((s) => s.readyMs);
    const audioIn = stt.stats().audioBytes - sttBefore;
    const audioOut = live.reduce((n, s) => n + s.audioBytes, 0);

    console.log(
      `  ${String(target).padStart(5)}  ${String(live.length).padStart(6)}` +
        `  ${(after.rssKb / 1024).toFixed(0).padStart(7)}` +
        `  ${perConn.toFixed(0).padStart(8)}` +
        `  ${cpu.toFixed(0).padStart(5)}` +
        `  ${driverCpu.toFixed(0).padStart(6)}` +
        `  ${(`${lagMax}ms`).padStart(8)}` +
        `  ${(`${pct(readyMs, 50)}/${pct(readyMs, 95)}ms`).padStart(13)}` +
        `  ${(`${(audioIn / elapsed / 1024).toFixed(0)}KiB/s`).padStart(10)}` +
        ` ${(`${(audioOut / 1024 / 1024).toFixed(0)}MiB`).padStart(6)}`,
    );

    const failed = sessions.filter((s) => s.error).length;
    if (failed > sessions.length * 0.05) {
      console.log(`\n  ${failed}/${sessions.length} sessions failed — stopping ramp`);
      const sample = sessions.find((s) => s.error);
      if (sample) console.log(`  first error: ${sample.error}`);
      break;
    }
  }

  clearInterval(sender);
  for (const s of sessions) {
    try {
      s.ws.close();
    } catch {
      /* already gone */
    }
  }
  child.kill();
  await stt.close();
  await tts.close();
  fs.rmSync(cert.dir, { recursive: true, force: true });
}

await main();
process.exit(0);
