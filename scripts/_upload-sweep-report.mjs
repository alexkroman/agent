// Copyright 2026 the AAI authors. MIT license.
/**
 * How `upload-sweep.mjs` summarizes a sweep.
 *
 * Split out on the 500-line cap, and the seam is the right one anyway: the
 * measuring half decides WHAT to send, and this half decides what a person may
 * conclude from what came back. Both of the first draft's real bugs were here —
 * a nearest-rank p50 that reported the SLOWEST run as the middle, and a knee
 * chosen from an unsorted list, so the "narrowest width that suffices" was
 * whichever cell the shuffle happened to put first.
 */

const MIB = 1024 * 1024;

/** Nearest-rank, which is what a tail number wants: p95 of 20 values is the 19th. */
export const percentile = (values, p) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
};

/**
 * The middle, AVERAGED on an even count — not `percentile(values, 50)`.
 *
 * The first draft was that, and nearest-rank p50 of two runs is the SLOWER one,
 * so every "wall (p50)" in the table was the worst run and identical to the top
 * of the range beside it. A summary that silently reports a maximum is worse
 * than no summary, because the range column made it look corroborated.
 */
export const median = (values) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
export const mbPerSecond = (bytes, ms) => bytes / MIB / (ms / 1000);
export const fixed = (value, places = 1) => value.toFixed(places);

/** One upload, timed, with its own request log. */
export function reportTable(results, fileBytes) {
  const rows = results.map((cell) => {
    const walls = cell.runs.filter((r) => r.error === undefined).map((r) => r.ms);
    const ok = walls.length;
    const mid = median(walls);
    const declined = cell.runs.some((r) => r.declined);
    return {
      declined,
      label: declined ? `${cell.label} (declined)` : cell.label,
      ok: `${ok}/${cell.runs.length}`,
      wall: ok === 0 ? "—" : `${fixed(mid / 1000, 2)}s`,
      range:
        ok < 2
          ? "—"
          : `${fixed(Math.min(...walls) / 1000, 2)}-${fixed(Math.max(...walls) / 1000, 2)}s`,
      rate: ok === 0 ? "—" : fixed(mbPerSecond(fileBytes, mid)),
      width: cell.width,
      partMib: cell.partMib,
      part:
        cell.runs[0].parts <= 1
          ? "—"
          : `${fixed(median(cell.runs.map((r) => r.partMsP50)) / 1000, 2)}s / ${fixed(
              median(cell.runs.map((r) => r.partMsP95)) / 1000,
              2,
            )}s`,
      retry: String(cell.runs.reduce((sum, r) => sum + r.retryable, 0)),
      fail: String(cell.runs.reduce((sum, r) => sum + r.failures, 0)),
      reset: String(cell.runs.reduce((sum, r) => sum + r.resets, 0)),
      rateValue: ok === 0 || declined ? 0 : mbPerSecond(fileBytes, mid),
      spread: ok < 2 ? 1 : Math.max(...walls) / Math.min(...walls),
    };
  });

  const header = [
    "cell",
    "landed",
    "wall (p50)",
    "range",
    "MB/s",
    "part p50/p95",
    "429+503",
    "4xx/5xx",
    "resets",
  ];
  const keys = ["label", "ok", "wall", "range", "rate", "part", "retry", "fail", "reset"];
  const widths = keys.map((key, i) =>
    Math.max(header[i].length, ...rows.map((row) => row[key].length)),
  );
  const line = (cells) => `| ${cells.map((c, i) => c.padEnd(widths[i])).join(" | ")} |`;
  console.log(`\n${line(header)}`);
  console.log(`| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`);
  for (const row of rows) console.log(line(keys.map((key) => row[key])));
  if (rows.some((row) => row.declined)) {
    console.log("\n(declined) = the parts path refused this cell and sent ONE request instead —");
    console.log("  the file fits in one part. Raise --mib or lower --part-mib to measure it.");
  }
  return rows;
}

/**
 * Say where the gain stops, and say it as a RANGE.
 *
 * The knee is the narrowest width within 5% of the best measured throughput —
 * "past here there is nothing left to buy", which is the sentence
 * `MAX_SEGMENT_CONCURRENCY`'s table exists to support. Deliberately not a
 * verdict on the constant: one sweep on one link is one row of the evidence a
 * number like that needs.
 */
export function reportKnee(rows) {
  const measured = rows.filter((row) => row.rateValue > 0 && row.label !== "1 request");
  // Widest-first would make the knee the FIRST row within 5%, which is the widest
  // fan-out rather than the narrowest that suffices.
  measured.sort((a, b) => a.width - b.width || a.partMib - b.partMib);
  if (measured.length < 2) return;
  const best = Math.max(...measured.map((row) => row.rateValue));
  const knee = measured.find((row) => row.rateValue >= best * 0.95);
  const single = rows.find((row) => row.label === "1 request");
  console.log(`\nbest ${fixed(best)} MB/s; within 5% of it from "${knee.label}" onward`);
  if (single !== undefined && single.rateValue > 0) {
    console.log(
      `one request: ${fixed(single.rateValue)} MB/s — the fan-out buys ${fixed(best / single.rateValue, 2)}x`,
    );
  }
  // A knee picked out of a cell whose own runs disagree by more than the gain is
  // not a knee, it is the luckiest run of a noisy cell — the exact reading the
  // repo's voice benchmarks keep having to un-learn. Say so rather than leaving
  // it to the RANGE column, which is the thing a reader skips.
  if (knee.spread > 2) {
    console.log(`  BUT "${knee.label}" spans ${fixed(knee.spread, 1)}x between its own runs —`);
    console.log("  that is noise, not a knee. Raise --repeat and --mib and run it again.");
  }
  console.log(
    "read the RANGE column before believing any of this, and re-run before moving a constant:",
  );
  console.log("  a single run is not evidence about the unlucky one.");
}
