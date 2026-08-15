/**
 * The plan's state, the web-search seam, and what the browser is shown.
 *
 * **The state is theirs, field for field.** `PlanExecute` in the notebook is
 * `{input, plan, past_steps, response}`, and {@link PlanState} is the same four
 * plus the one thing a phone call needs on top: the trail of how the plan got
 * to where it is, which the sidebar renders and a caller cannot hold by ear.
 *
 * **A plan does not survive the call, and that is a decision.** It lives in
 * `ctx.state`, so two callers planning at once never see each other's steps and
 * an abandoned plan vanishes with the session. Cross-session persistence would
 * mean `ctx.db` and a caller identity, which is a different template
 * (`solo-rpg` has the save-slot version).
 */

import { pushCapped, sessionSlot } from "@alexkroman1/aai";
import { webSearch } from "@alexkroman1/aai/tools";
import { isToolFailure } from "@alexkroman1/aai/utils";

/** One completed step — their `past_steps`, as a pair rather than a tuple. */
export interface PastStep {
  step: string;
  result: string;
  /** Searches this step ran, so the sidebar can show what the wait bought. */
  searches: string[];
}

export interface PlanState {
  /** Their `input`: what the caller asked for. */
  objective: string | null;
  /** Their `plan`: the steps STILL to do, head first. */
  plan: string[];
  /** Their `past_steps`. */
  pastSteps: PastStep[];
  /** Their `response`: set once the replanner decides the objective is met. */
  response: string | null;
  /** Every plan the desk has held on this call, for the sidebar. */
  revisions: string[];
}

/** Growth cap on the revision trail — it rides in every `syncState` frame. */
export const MAX_REVISIONS = 20;

export function emptyPlan(): PlanState {
  return { objective: null, plan: [], pastSteps: [], response: null, revisions: [] };
}

export const planSlot = sessionSlot("plan", emptyPlan);

export function noteRevision(state: PlanState, entry: string): void {
  pushCapped(state.revisions, entry, MAX_REVISIONS);
}

// ─── The search seam ─────────────────────────────────────────────────────────

export interface SearchHit {
  title: string;
  url: string;
}

/**
 * The executor's search, as an injected function.
 *
 * The seam exists because the search is REAL — `webSearch` from
 * `@alexkroman1/aai/tools` is the same DuckDuckGo-backed implementation behind
 * the model-facing `web_search` builtin, with the same screening and size caps,
 * and it needs no API key. A template's spec must not depend on the live web
 * (or on a stranger's rate limit), so the executor takes its searcher as an
 * argument and the tool passes {@link liveSearch}.
 */
export type SearchFn = (query: string) => Promise<SearchHit[]>;

/** How many results one search reads. Enough to compare, short enough to hear. */
export const SEARCH_RESULTS = 4;

export const liveSearch: SearchFn = async (query) => {
  const results = await webSearch<{ results?: { title?: string; url?: string }[] }>({
    query,
    max_results: SEARCH_RESULTS,
  });
  // A REFUSED search is not an empty web, and `webSearch` answers with
  // `{ error }` rather than throwing — so an unnarrowed `?? []` below would tell
  // the executor there is nothing out there. Measured: DuckDuckGo answers `403`
  // often enough that this is the ordinary case, not an edge one.
  if (isToolFailure(results)) throw new Error(`Search failed: ${results.error}`);
  return (results.results ?? [])
    .filter(
      (one): one is { title?: string; url: string } =>
        typeof one.url === "string" && one.url.length > 0,
    )
    .map((one) => ({ title: one.title || one.url, url: one.url }));
};

// ─── The projection ──────────────────────────────────────────────────────────

export interface PlanView {
  objective: string | null;
  /** Steps still to do. */
  plan: string[];
  done: PastStep[];
  response: string | null;
  revisions: string[];
  /** Done ÷ (done + remaining), 0–1, so the sidebar needs no arithmetic. */
  progress: number;
}

/**
 * What the browser sees. Nearly the state — a plan has nothing private in it —
 * with `progress` derived here so the bar and any spoken "two of four" can
 * never disagree about what fraction means.
 */
export function planView(state: PlanState): PlanView {
  const done = state.pastSteps.length;
  const total = done + state.plan.length;
  return {
    objective: state.objective,
    plan: state.plan,
    done: state.pastSteps,
    response: state.response,
    revisions: state.revisions,
    progress: total === 0 ? 0 : done / total,
  };
}
