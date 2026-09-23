// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `metrics`.
 *
 * What one reply cost, stage by stage — the `metrics.collected` frame an
 * `agent({ events })` hook receives — and the collector that folds many of
 * them into a summary.
 *
 * The frame's TYPE is here even though its schema lives on the non-authoring
 * `/protocol` subpath, for the reason `SessionEventType` is on `agent`: an
 * author writes `(e: MetricsCollectedEvent) => …` and reads `e.llm?.ttftMs`,
 * so the field names ARE the API, and a stage renamed on the wire must be a
 * classification here rather than a silent break in a user's dashboard.
 *
 * `MetricsSummary`'s ABSENT-until-sampled stats and the windowed percentiles
 * are behaviour a signature cannot carry; `metrics-collector.test.ts` pins
 * both.
 *
 * Re-exported from `@alexkroman1/aai`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  createMetricsCollector,
  type MetricStat,
  type MetricsCollectedEvent,
  type MetricsCollector,
  type MetricsCollectorOptions,
  type MetricsSample,
  type MetricsSummary,
} from "../../index.ts";
