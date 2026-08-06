// Boots a real AAI pipeline agent with host mode enabled, as the target for
// replay.py. Every turn-taking knob is a LAB_* env var so an A/B needs no code
// edit — see scripts/README.md.
//
// Imported by PACKAGE NAME, like every other cross-package import in the repo.
// That works because the root package.json takes `@alexkroman1/aai` as a
// `workspace:*` devDependency purely so this file can — `scripts/` is not
// itself a workspace package, so without that link a bare specifier has
// nothing to resolve against and these were relative paths reaching into
// `packages/aai/`, the one thing `noRestrictedImports` exists to forbid.
// Run with `--conditions=@dev/source`, which maps the subpaths to TS source.

import { agent } from "@alexkroman1/aai";
import { anthropic } from "@alexkroman1/aai/llm";
import { createRuntime, createServer } from "@alexkroman1/aai/runtime";
import { assemblyAIStt } from "@alexkroman1/aai/stt";
import { assemblyAITts } from "@alexkroman1/aai/tts";

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
console.log(
  JSON.stringify({
    ready: true,
    port,
    sttOpts,
    minBargeInWords: base.minBargeInWords,
    interruptionMinDurationMs: base.interruptionMinDurationMs,
    falseInterruptionTimeoutMs: base.falseInterruptionTimeoutMs,
  }),
);
