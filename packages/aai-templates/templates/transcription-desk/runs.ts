// Copyright 2026 the AAI authors. MIT license.
/**
 * The runs this browser has started.
 *
 * A run is DURABLE and the page is not — it survives the tab closing, finishes
 * on a sandbox this browser never spoke to, and can be read back hours later
 * with `curl`. The whole handle is the `runId`, so the only thing standing
 * between a user and a finished transcript is having kept that string.
 * `localStorage` is where a page keeps a string.
 *
 * **This is deliberately CLIENT-side and therefore per-browser.** The workflow
 * API has no list-runs route (a run is addressed by id, and enumerating another
 * caller's runs is not something a public endpoint should offer), so a shared
 * list would mean new agent surface. What the list is FOR is demonstrating that
 * the run outlived the page, and a browser's own history demonstrates that
 * exactly as well.
 */

/** One run this browser started. */
export type SavedRun = {
  runId: string;
  /** The file the user picked — the only human-readable handle on a run. */
  label: string;
  /** Epoch ms, for ordering. */
  startedAt: number;
};

const STORAGE_KEY = "transcription-desk:runs";

/**
 * How many runs to remember.
 *
 * The list is a demonstration, not an archive, and `localStorage` is a shared
 * ~5 MB quota for the whole origin — an unbounded list eventually throws
 * `QuotaExceededError` on a write that has nothing to do with its own size.
 */
const MAX_REMEMBERED = 20;

/** Narrow one parsed entry, so a hand-edited or older value cannot crash a render. */
function isSavedRun(value: unknown): value is SavedRun {
  if (typeof value !== "object" || value === null) return false;
  const run = value as Partial<SavedRun>;
  return (
    typeof run.runId === "string" &&
    typeof run.label === "string" &&
    typeof run.startedAt === "number"
  );
}

/**
 * Read the remembered runs, newest first.
 *
 * Every failure answers `[]`. `localStorage` is not merely "sometimes empty":
 * reading it THROWS outright when a browser blocks storage (Safari's private
 * mode, a third-party iframe, a hardened profile), and the contents are a
 * string any extension or older build of this page could have written. A
 * transcription app must not fail to load over its own history sidebar.
 */
export function loadRuns(): SavedRun[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isSavedRun).slice(0, MAX_REMEMBERED) : [];
  } catch {
    return [];
  }
}

/**
 * Add `run` to the remembered list and return the new list, newest first.
 *
 * Returns the list rather than mutating in place so the caller can hand it
 * straight to `setState` — and re-reads from storage first, so two tabs of the
 * same app do not overwrite each other's history wholesale.
 *
 * A failed WRITE is swallowed for the same reason a failed read is: the run has
 * already started and is safe on the server, so losing the bookmark must not
 * look like losing the transcription.
 */
export function rememberRun(run: SavedRun): SavedRun[] {
  // De-duplicated by id: re-running the same file makes a new run with a new
  // id, but a caller that retries a start must not double the entry.
  const next = [run, ...loadRuns().filter((seen) => seen.runId !== run.runId)].slice(
    0,
    MAX_REMEMBERED,
  );
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked or full — the list is still correct for this page's life.
  }
  return next;
}
