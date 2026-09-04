// The server under test. Runs in its own process so RSS and CPU are read
// straight from /proc without the load driver's cost mixed in.
//
// Providers are pointed at the local fakes via the documented staging
// overrides (`assemblyAIStt({ streamingUrl })`, `assemblyAITts({ host })`), so
// every layer above the provider socket is the real one: the real handshake,
// the real per-connection runtime, the real pipeline transport, the real
// audio pacer.

import { assemblyAILlm } from "@alexkroman1/aai/llm";
import { assemblyAIStt } from "@alexkroman1/aai/stt";
import { assemblyAITts } from "@alexkroman1/aai/tts";
import { createHostServer } from "@alexkroman1/aai-runtime";

const { BENCH_STT_URL, BENCH_TTS_HOST, BENCH_PORT } = process.env;

const log = (...a) => process.stderr.write(`${a.map(String).join(" ")}\n`);
const quiet = process.env.BENCH_DEBUG
  ? { info: log, warn: log, error: log, debug: log }
  : { info() {}, warn() {}, error() {}, debug() {} };

const server = createHostServer({
  logger: quiet,
  defaults: {
    // `omitUndefined`-by-hand: under `exactOptionalPropertyTypes` an absent
    // option and one explicitly `undefined` are different types, and these
    // two come from `process.env`.
    stt: assemblyAIStt(BENCH_STT_URL === undefined ? {} : { streamingUrl: BENCH_STT_URL }),
    llm: assemblyAILlm({}),
    tts: assemblyAITts(BENCH_TTS_HOST === undefined ? {} : { host: BENCH_TTS_HOST }),
  },
});

await server.listen(Number(BENCH_PORT));

// Event-loop lag: the number that actually says whether the process is
// keeping up. RSS can look fine while every session's audio is arriving late.
let lagMax = 0;
let last = process.hrtime.bigint();
const TICK_MS = 20;
setInterval(() => {
  const now = process.hrtime.bigint();
  const lag = Number(now - last) / 1e6 - TICK_MS;
  if (lag > lagMax) lagMax = lag;
  last = now;
}, TICK_MS).unref();

setInterval(() => {
  process.stdout.write(`${JSON.stringify({ lagMax: Math.round(lagMax) })}\n`);
  lagMax = 0;
}, 1000).unref();

process.stdout.write("ready\n");
