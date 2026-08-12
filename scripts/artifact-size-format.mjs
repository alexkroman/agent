/**
 * The vocabulary shared by the three artifact-size modules.
 *
 * A leaf: it imports nothing. `artifact-size-report.mjs` measures,
 * `artifact-size-markdown.mjs` renders, and `artifact-size-budget.mjs` enforces,
 * and all three need the same constants and the same number formatting. Having
 * the renderer import the formatters back out of the report made a cycle
 * (`noImportCycles`), which is the signal that the shared half wanted its own
 * home rather than that the split was wrong.
 */

/** Report envelope, so a stale or foreign JSON is rejected rather than read. */
export const REPORT_KIND = "aai-artifact-size-report";
export const REPORT_SCHEMA_VERSION = 1;

/**
 * Fractional growth a single metric may show before the budget fails.
 *
 * Shared by every artifact rather than tuned per artifact, which is why the
 * remedy for an intended regression is the acknowledgement label and never a
 * higher number here.
 */
export const SIZE_BUDGET_THRESHOLD = 0.1;

export function formatBytes(bytes) {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} kB`;
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}

export function formatSignedBytes(bytes) {
  if (bytes === 0) return "—";
  return `${bytes > 0 ? "+" : "-"}${formatBytes(Math.abs(bytes))}`;
}

/** A growth ratio as a percentage; `Infinity` means the metric is new. */
export function formatRatioPercent(ratio) {
  if (!Number.isFinite(ratio)) return "new";
  return `${(ratio * 100).toFixed(1)}%`;
}
