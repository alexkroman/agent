// Copyright 2026 the AAI authors. MIT license.
/**
 * Regenerate the gateway model catalog in the SDK from the gateway itself.
 *
 * `GET /v1/models` is the source of truth, in both regions. Everything this
 * replaces was hand-maintained and wrong in a different way each time:
 *
 * - the model list had `kimi-k2.5` (deprecated) and
 *   `gemini-3.1-flash-lite-preview` (never existed), and was missing nine
 *   real models including `claude-sonnet-5` and `gpt-5.6-*`;
 * - EU availability was inferred from id prefixes, which computed ten models
 *   where the EU endpoint serves six — so four of the ten 404;
 * - nothing recorded that `gpt-oss-20b`/`gpt-oss-120b` cannot stream, which
 *   every pipeline turn requires.
 *
 * `supported_parameters` from the endpoint is what makes the last one
 * expressible at all, so the catalog carries capabilities rather than just
 * ids.
 *
 *   node scripts/gen-gateway-models.mjs         # print the constant
 *   node scripts/gen-gateway-models.mjs --write # rewrite it in place
 *
 * The endpoint is not infallible — it still lists `kimi-k2.5`, which answers
 * 410 when called — so `check-gateway-models.mjs` probes as well. Listing and
 * working are different claims.
 */

import { writeFileSync } from "node:fs";

import { apiKey } from "./_api-key.mjs";
import { parseScriptArgs } from "./_args.mjs";
import { compareNames } from "./_fs.mjs";

const { values: FLAGS } = parseScriptArgs({
  script: import.meta.url,
  options: { write: { type: "boolean" } },
});

const US = "https://llm-gateway.assemblyai.com/v1/models";
const EU = "https://llm-gateway.eu.assemblyai.com/v1/models";
const CHAT = "https://llm-gateway.assemblyai.com/v1/chat/completions";
const TARGET = new URL("../packages/aai/src/sdk/providers/llm/gateway-models.ts", import.meta.url);

/**
 * One entry of the gateway's `/models` list, as this generator reads it.
 *
 * Only the four fields below are consulted; naming them means a renamed field
 * upstream is a compile error here rather than a catalog that silently loses a
 * capability column — `check-gateway-models.mjs` has already been burned once
 * by a parse that quietly produced zero entries.
 *
 * @typedef {{ id: string, supported_parameters?: string[], context_length?: number }} GatewayModel
 */

/**
 * @param {string | URL} url
 * @param {string} key
 * @returns {Promise<GatewayModel[]>}
 */
async function models(url, key) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  // `Response.json()` answers `unknown`; the gateway's list endpoint answers
  // `{ data: [...] }`, and `?? []` covers a body that carries no `data`.
  const body = /** @type {{ data?: GatewayModel[] }} */ (await res.json());
  return body.data ?? [];
}

/**
 * Does the model answer a request of the shape this SDK sends?
 *
 * Not the same question as "is it advertised". `/v1/models` lists
 * `kimi-k2.5`, which answers 410, and `gemini-3.6-flash`, which answers
 * `400 model gemini-3.6-flash can only be used with model_region = 'global'`
 * — a parameter nothing here sends. Both are unusable for us, which is the
 * decision this flag drives, so both are recorded the same way rather than
 * split into a taxonomy no caller would branch on.
 *
 * Only 400 and 410 count. Any other failure — a timeout, a 429, a real
 * outage — leaves the model in, because a transient blip must not silently
 * delete a working model on whichever afternoon someone regenerates.
 */
async function isLive(id, key) {
  const res = await fetch(CHAT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: id, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
  }).catch(() => null);
  if (!res) return true;
  return !(res.status === 400 || res.status === 410);
}

const key = apiKey();
const [us, eu] = await Promise.all([models(US, key), models(EU, key)]);
const euIds = new Set(eu.map((m) => m.id));
const live = new Map(
  // The `@returns` is what makes the body a TUPLE rather than an array.
  await Promise.all(
    us.map(
      /** @returns {Promise<[id: string, live: boolean]>} */ async (m) => [
        m.id,
        await isLive(m.id, key),
      ],
    ),
  ),
);

const entries = us
  .map((m) => {
    const p = new Set(m.supported_parameters ?? []);
    return {
      id: m.id,
      tools: p.has("tools"),
      stream: p.has("stream"),
      eu: euIds.has(m.id),
      live: live.get(m.id) !== false,
      context: m.context_length ?? 0,
    };
  })
  // Code-unit order, never `localeCompare`: this writes a COMMITTED generated
  // artifact (`gateway-models.ts`) that `check-gateway-models.mjs` compares byte
  // for byte, and `localeCompare` with no explicit locale answers to the
  // runtime's ICU default — so the same catalog would produce a different file
  // on a different machine and the gate would report a change that is really a
  // locale. `_api-surface.mjs` states the rule; this is the second artifact it
  // applies to.
  .sort((a, b) => compareNames(a.id, b.id));

const body = entries
  .map(
    (e) =>
      `  ${JSON.stringify(e.id)}: { tools: ${e.tools}, stream: ${e.stream}, ` +
      `eu: ${e.eu}, live: ${e.live}, context: ${e.context} },`,
  )
  .join("\n");

/**
 * The id union, spelled out rather than derived with `keyof typeof`.
 *
 * `AssemblyAIGatewayModel` is PUBLISHED (`AssemblyAILlmOptions.model` narrows
 * to it), and `keyof typeof ASSEMBLYAI_GATEWAY_MODELS` makes the rollup inline
 * the whole 30-model × 5-field literal type to express it — about 190 of the
 * 454 lines the `/llm` report used to be. The epoch hash covers that body, so
 * regenerating this catalog, which is routine ops, forced an `aai:llm`
 * classification for a change no author can see. Written out, a regeneration
 * touches roughly two lines of the report.
 */
const union = entries.map((e) => `  | ${JSON.stringify(e.id)}`).join("\n");

const file = `// Copyright 2026 the AAI authors. MIT license.
/**
 * The AssemblyAI LLM Gateway model catalog.
 *
 * GENERATED — run \`node scripts/gen-gateway-models.mjs --write\` to refresh,
 * and \`pnpm check:gateway-models\` to verify. Do not hand-edit: every
 * hand-maintained version of this list was wrong. One carried a deprecated
 * model and one that had never existed while missing nine real ones; another
 * inferred EU availability from id prefixes and produced four models the EU
 * endpoint does not serve.
 *
 * Capabilities come from the endpoint's \`supported_parameters\` and are not
 * decoration:
 *
 * - \`stream: false\` cannot be used for a voice pipeline or a studio turn at
 *   all — both stream. Two listed models are in this category.
 * - \`tools: false\` cannot run an agent that has tools.
 *
 * A model being listed here means the gateway advertises it, which is a
 * weaker claim than it working: \`kimi-k2.5\` is advertised and answers 410.
 * That is why the check script probes rather than trusting this file.
 *
 * Only the id UNION is published, on \`@alexkroman1/aai/llm\`, because
 * \`AssemblyAILlmOptions.model\` narrows to it for autocomplete. The catalog
 * itself, its row type and \`gatewayModelIds\` are on
 * \`@alexkroman1/aai/host-internal\`: their reader is the studio's model
 * selection and this repo's own gate, never an \`agent.ts\`.
 */

export type GatewayModelInfo = {
  /** Accepts a \`tools\` array — required for any agent with tools. */
  readonly tools: boolean;
  /** Supports \`stream: true\` — required for voice pipelines and studio chat. */
  readonly stream: boolean;
  /** Served by the EU endpoint (\`llm-gateway.eu.assemblyai.com\`). */
  readonly eu: boolean;
  /**
   * Answered a minimal request, as this SDK sends one, when generated.
   * \`false\` means the gateway advertises the model and will not run it for
   * us: \`kimi-k2.5\` answers 410 (deprecated), \`gemini-3.6-flash\` answers
   * 400 (needs a \`model_region\` parameter nothing here sends).
   */
  readonly live: boolean;
  /** Context window in tokens, as the gateway reports it. */
  readonly context: number;
};

/** An id the gateway advertises. */
export type AssemblyAIGatewayModel =
${union};

export const ASSEMBLYAI_GATEWAY_MODELS = {
${body}
} as const satisfies Record<AssemblyAIGatewayModel, GatewayModelInfo>;

/**
 * Ids usable for a streaming, tool-calling agent — the only shape this SDK
 * runs — and that actually answer. Deriving it beats another hand-kept list:
 * a model that is deprecated or loses \`stream\` upstream drops out on the
 * next regeneration instead of waiting to be noticed.
 */
export function gatewayModelIds(opts: { eu?: boolean } = {}): AssemblyAIGatewayModel[] {
  return (Object.entries(ASSEMBLYAI_GATEWAY_MODELS) as [AssemblyAIGatewayModel, GatewayModelInfo][])
    .filter(([, m]) => m.live && m.tools && m.stream && (!opts.eu || m.eu))
    .map(([id]) => id);
}
`;

if (FLAGS.write === true) {
  writeFileSync(TARGET, file);
  console.error(`wrote ${entries.length} models (${eu.length} EU) to ${TARGET.pathname}`);
} else {
  process.stdout.write(file);
}
