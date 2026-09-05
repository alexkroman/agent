// Fake AssemblyAI STT and TTS endpoints, faithful to the two wire contracts
// the adapters actually depend on. They run in the DRIVER process so their
// cost never lands in the number we are measuring — which also matches
// production, where the providers are somebody else's machines.
//
// What this deliberately does NOT reproduce: TLS to a remote host, and WAN
// latency. Both are real per-session costs in production, so the capacity
// numbers this produces are an upper bound. See README.md.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";

/**
 * Bytes in one `ws` message, across all three shapes `RawData` can take.
 *
 * `data.length` was wrong on two of them and this benchmark REPORTS the number:
 * an `ArrayBuffer` has `byteLength` and no `length`, so the total went `NaN`,
 * and a `Buffer[]` (what ws hands over a fragmented message) answers the count
 * of CHUNKS, so the total silently undercounted by orders of magnitude. Neither
 * shows up as a failure — the bench just prints a wrong throughput.
 *
 * @param {import("ws").RawData} data
 * @returns {number}
 */
const messageBytes = (data) => {
  if (Array.isArray(data)) return data.reduce((total, chunk) => total + chunk.length, 0);
  return data instanceof ArrayBuffer ? data.byteLength : data.length;
};

/**
 * The port a listening server bound to.
 *
 * `address()` answers `string | AddressInfo | null` — `null` before `listen`
 * resolves and a string for a unix socket — and both fakes read `.port` off it
 * directly. Neither case can happen here (both are TCP, both read inside the
 * `listen` callback), so this is where that is said once and loudly.
 *
 * @param {import("node:net").Server} server
 * @returns {number}
 */
function addressPort(server) {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("bench fake: expected a listening TCP server");
  }
  return address.port;
}

/** A self-signed cert for 127.0.0.1 — the TTS adapter hardcodes `wss://`. */
export function makeCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-tls-"));
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  return { key, cert, dir };
}

/**
 * STT: the vendor SDK resolves its connect promise on `Begin` and nothing
 * else, so that frame is the whole handshake contract. Audio arrives as
 * binary; we emit a `Turn` partial every `partialEveryFrames` to exercise the
 * transcript path, and never set `end_of_turn` — a committed turn would call
 * the LLM, which this benchmark has no key for. Steady-state audio in,
 * partials out is the state a live call spends nearly all its time in.
 */
export function startFakeStt({ key, cert, partialEveryFrames = 25 }) {
  // TLS even though this is loopback: the vendor SDK refuses a `ws://`
  // websocketBaseUrl outright ("Invalid protocol, must be wss").
  const httpsServer = https.createServer({
    key: fs.readFileSync(key),
    cert: fs.readFileSync(cert),
  });
  const wss = new WebSocketServer({ server: httpsServer, perMessageDeflate: false });
  let audioBytes = 0;
  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "Begin", id: "bench", expires_at: Date.now() / 1000 + 3600 }));
    let n = 0;
    ws.on("message", (data, isBinary) => {
      if (!isBinary) return;
      audioBytes += messageBytes(data);
      if (++n % partialEveryFrames !== 0) return;
      ws.send(
        JSON.stringify({
          type: "Turn",
          turn_order: 0,
          transcript: "the quick brown fox",
          end_of_turn: false,
          turn_is_formatted: false,
          words: [],
        }),
      );
    });
    ws.on("error", () => {});
  });
  return new Promise((resolve) => {
    httpsServer.listen(0, "127.0.0.1", () => {
      resolve({
        url: () => `wss://127.0.0.1:${addressPort(httpsServer)}/v3/ws`,
        stats: () => ({ audioBytes }),
        close: () => new Promise((r) => httpsServer.close(r)),
      });
    });
  });
}

/**
 * TTS: the adapter needs only an open socket (production sends no `Begin`
 * until the client speaks). A turn is `Generate` + `Flush`; we answer with one
 * `Audio` frame of silence sized to the text, then `FlushDone`, which is what
 * ends the turn. Sizing the audio to the text keeps the outbound byte volume
 * in the right order of magnitude rather than making playback free.
 */
export function startFakeTts({ key, cert, sampleRate = 16_000 }) {
  const httpsServer = https.createServer({
    key: fs.readFileSync(key),
    cert: fs.readFileSync(cert),
  });
  const wss = new WebSocketServer({ server: httpsServer, perMessageDeflate: false });
  let flushes = 0;
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "Generate") {
        // ~70ms of speech per word, PCM16 mono.
        const words = Math.max(1, msg.text.trim().split(/\s+/).length);
        const samples = Math.round(sampleRate * 0.07 * words);
        ws.send(
          JSON.stringify({ type: "Audio", audio: Buffer.alloc(samples * 2).toString("base64") }),
        );
        return;
      }
      if (msg.type === "Flush") {
        flushes++;
        ws.send(JSON.stringify({ type: "FlushDone" }));
      }
    });
    ws.on("error", () => {});
  });
  return new Promise((resolve) => {
    httpsServer.listen(0, "127.0.0.1", () => {
      resolve({
        host: () => `127.0.0.1:${addressPort(httpsServer)}`,
        stats: () => ({ flushes }),
        close: () => new Promise((r) => httpsServer.close(r)),
      });
    });
  });
}
