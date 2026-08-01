// Copyright 2026 the AAI authors. MIT license.
/**
 * Probe every model in `ASSEMBLYAI_GATEWAY_MODELS` against the live gateway.
 *
 * The list is hand-maintained and had drifted in both directions before this
 * existed: `kimi-k2.5` had been deprecated and `gemini-3.1-flash-lite-preview`
 * had never existed, and both were being offered as choices — one of them
 * reachable through `STUDIO_LLM_MODEL`.
 *
 * A stale entry is worse here than it sounds, because the gateway hides the
 * reason on the path we actually use. Non-streaming, a dead model answers
 * `410 the model version you are trying to access has been deprecated`.
 * Streaming — which every real turn does — it answers `500 "something went
 * wrong"`, which the AI SDK retries three times before surfacing "Internal
 * Server Error". So a wrong entry in this list presents as a provider outage,
 * or as a model that ran for twelve seconds and did nothing.
 *
 * Deliberately NOT in CI: it spends (a trivial amount of) real tokens on the
 * caller's own key and depends on a third-party service being up. Run it when
 * adding a model, and when one starts misbehaving.
 *
 *   node scripts/check-gateway-models.mjs
 *
 * Exits non-zero if any listed model is unreachable.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const GATEWAY = "https://llm-gateway.assemblyai.com/v1/chat/completions";

function apiKey() {
  if (process.env.ASSEMBLYAI_API_KEY) return process.env.ASSEMBLYAI_API_KEY;
  const cfg = path.join(homedir(), ".config", "aai", "config.json");
  const key = JSON.parse(readFileSync(cfg, "utf-8")).apiKey;
  if (!key) throw new Error("no apiKey in ~/.config/aai/config.json");
  return key;
}

const { ASSEMBLYAI_GATEWAY_MODELS } = await import(
  new URL("../packages/aai-studio-server/studio-llm.ts", import.meta.url).href
);

const key = apiKey();
const dead = [];

for (const model of ASSEMBLYAI_GATEWAY_MODELS) {
  // One token, no streaming: the cheapest request that still proves the model
  // resolves, and the non-streaming path is the one that reports WHY it does
  // not.
  const res = await fetch(GATEWAY, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  if (res.ok) {
    console.log(`  ok    ${model}`);
    continue;
  }
  const detail = (await res.text()).replace(/\s+/g, " ").slice(0, 160);
  console.log(`  ${res.status}   ${model}  ${detail}`);
  dead.push(model);
}

if (dead.length > 0) {
  console.error(
    `\ncheck-gateway-models: ${dead.length} unreachable model(s): ${dead.join(", ")}.\n` +
      "Remove them from ASSEMBLYAI_GATEWAY_MODELS — an unreachable entry reaches\n" +
      "users as a retried 500, not as a clear error.",
  );
  process.exit(1);
}
console.log(`\ncheck-gateway-models: all ${ASSEMBLYAI_GATEWAY_MODELS.length} models reachable. ✓`);
