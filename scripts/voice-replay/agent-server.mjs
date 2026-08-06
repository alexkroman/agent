// Boots a real AAI pipeline agent with host mode enabled, as the target for
// replay.py. Every turn-taking knob is a LAB_* env var so an A/B needs no code
// edit — see scripts/README.md.
//
// Imports reach into packages/aai by RELATIVE path rather than by package name
// (which the repo otherwise requires): `scripts/` is not a workspace package,
// so nothing links `@alexkroman1/aai` into a node_modules above it and a bare
// specifier cannot resolve here. Run with `--conditions=@dev/source`, which is
// what maps these to TypeScript source.
import { agent } from "../../packages/aai/index.ts";
import { createRuntime, createServer } from "../../packages/aai/host/runtime-barrel.ts";
import { anthropic } from "../../packages/aai/sdk/providers/llm-barrel.ts";
import { assemblyAIStt } from "../../packages/aai/sdk/providers/stt-barrel.ts";
import { assemblyAITts } from "../../packages/aai/sdk/providers/tts-barrel.ts";

const num = (k, d) => (process.env[k] !== undefined ? Number(process.env[k]) : d);
const str = (k, d) => (process.env[k] !== undefined ? process.env[k] : d);

const sttOpts = {
  languages: ["en"],
  minTurnSilenceMs: num("LAB_MIN_TURN_SILENCE_MS", 1600),
  maxTurnSilenceMs: num("LAB_MAX_TURN_SILENCE_MS", 3500),
  voiceFocus: str("LAB_VOICE_FOCUS", "near-field"),
  voiceFocusThreshold: num("LAB_VOICE_FOCUS_THRESHOLD", 0.9),
};

const base = agent({
  name: "turnlab",
  systemPrompt: "You are a helpful retail support agent.",
  greeting: "Thank you for calling. How can I help you today?",
  stt: assemblyAIStt(sttOpts),
  llm: anthropic({ model: str("LAB_LLM", "claude-sonnet-5") }),
  tts: assemblyAITts({ voice: str("LAB_VOICE", "michael") }),
  minBargeInWords: num("LAB_MIN_BARGE_IN_WORDS", 2),
  interruptionMinDurationMs: num("LAB_INTERRUPTION_MIN_DURATION_MS", 500),
  falseInterruptionTimeoutMs: num("LAB_FALSE_INTERRUPTION_TIMEOUT_MS", 2000),
});

const env = {
  ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY ?? "",
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
  AAI_ALLOW_HOST: "1",
};

const runtime = createRuntime({ agent: base, env, providerEnv: env });
const server = createServer({ runtime, name: "turnlab", env, hostBaseAgent: base });
const port = num("LAB_PORT", 8791);
await server.listen(port);
console.log(JSON.stringify({ ready: true, port, sttOpts,
  minBargeInWords: base.minBargeInWords,
  interruptionMinDurationMs: base.interruptionMinDurationMs,
  falseInterruptionTimeoutMs: base.falseInterruptionTimeoutMs }));
