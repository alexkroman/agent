// Copyright 2025 the AAI authors. MIT license.
/**
 * Capability contract: `utils`.
 *
 * The zero-dependency helpers a TOOL body may reach for: error rendering, the
 * capped append, the keyed lock, and the two shape helpers. (`toolFailure` and
 * its guard are the `tool` capability's — a name belongs to exactly one
 * contract, and the failure a tool RETURNS is part of what writing a tool is.)
 *
 * It used to be twice this and cover three unrelated readers, because the
 * subpath's membership rule was a BUILD property ("zod-free, so the CLI can
 * import it on every invocation") rather than an audience. The STEP
 * vocabulary is the `step` capability now (`@alexkroman1/aai/step`), and the
 * framework's own wire helpers and platform contracts are on
 * `@alexkroman1/aai/internal`, which is not contracted at all — it is explicitly
 * not semver-covered.
 *
 * The four NARRATION formatters joined it, and the reader is what puts them here
 * rather than on a subpath of their own: `formatBytes`, `formatDuration`,
 * `countWords`, `formatMoney` and `plural` are written from a `workflows/*.ts` step reporting
 * its own progress AND from the `client.tsx` rendering the same run, and
 * `/utils` is already the import both halves reach for. They are on this
 * contract because their OUTPUT is the promise — each returns one fixed ASCII
 * shape documented to the character, deliberately un-localized, so a spec may
 * assert the exact string and a page and a step cannot disagree about the same
 * run. (They did: one template printed a 64-minute recording as `1:04:09` from
 * its workflow and `64:09` from its page.) A change to what one PRINTS is a
 * change to this contract, which is the reason to version it here.
 *
 * `createKeyedLock`/`withLock` are the one pair here with a runtime dependency
 * (`p-timeout`, 2.4 KB, for the optional acquire deadline) and the one an agent
 * author most needs: the LLM loop runs a step's tool calls CONCURRENTLY, so two
 * async mutators of one external resource interleave at every await. A
 * session-state mutation is not that case — `slot.update`'s window is
 * synchronous — which is what the `state` capability is for.
 *
 * Re-exported from `@alexkroman1/aai/utils`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export {
  countWords,
  createKeyedLock,
  decodeHtmlEntities,
  errorDetail,
  errorMessage,
  formatBytes,
  formatDuration,
  formatMoney,
  isRecord,
  type KeyedLock,
  type KeyedLockOptions,
  KeyedLockTimeoutError,
  omitUndefined,
  plural,
  pushCapped,
  responseErrorMessage,
  safeJsonParse,
  withLock,
} from "../../sdk/utils.ts";
