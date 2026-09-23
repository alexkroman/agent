// Copyright 2026 the AAI authors. MIT license.
/**
 * Fold `metrics.collected` frames into a running summary.
 *
 * The event is per REPLY (see `protocol-events-metrics.ts`), and almost every
 * question asked of it is about many replies — "what is this agent's p95
 * latency", "how many TTS characters did this session bill" — so every reader
 * would otherwise write the same fold, and get the percentile wrong in the
 * same way. This is that fold, once:
 *
 * ```ts
 * import { agent, createMetricsCollector } from "@alexkroman1/aai";
 *
 * const metrics = createMetricsCollector();
 *
 * export default agent({
 *   name: "Concierge",
 *   systemPrompt: "…",
 *   events: {
 *     "metrics.collected": (e) => {
 *       metrics.collect(e);
 *       const { replies, latencyMs } = metrics.summary();
 *       if (replies % 20 === 0) console.log("p95 latency (ms)", latencyMs?.p95);
 *     },
 *   },
 * });
 * ```
 *
 * It is pure — no clock, no I/O, no dependency — which is what lets one
 * implementation serve an agent's hooks, the runtime's own sinks and a browser
 * dashboard alike.
 *
 * ## Percentiles are over a WINDOW, and the window is bounded
 *
 * `count`, `min`, `max` and `mean` are exact over every sample ever collected.
 * `p50` and `p95` are over the most recent `maxSamples` (1000 by default),
 * because an exact percentile needs every sample and a collector that lives as
 * long as a process must not grow with it. A window is also the more useful
 * answer for a long-lived reader: the p95 of the last thousand replies moves
 * when the agent gets slower, where an all-time p95 barely would.
 *
 * @module
 */

import type { SessionEvent } from "./session-event-map.ts";

/**
 * One `metrics.collected` frame, envelope included — what an
 * `events: { "metrics.collected" }` hook receives.
 *
 * Declared here, off the session event union, rather than beside its schema:
 * the schema lives on the non-authoring `/protocol` surface, and this is the
 * name an author annotates a handler with.
 * @public
 */
export type MetricsCollectedEvent = SessionEvent<"metrics.collected">;

/**
 * What {@link MetricsCollector.collect} reads off one frame — the event
 * without its envelope, so a hook's event and a transport's body both fit.
 * @public
 */
export type MetricsSample = Omit<MetricsCollectedEvent, "type" | "meta">;

/**
 * One measurement's distribution. Durations are milliseconds.
 * @public
 */
export interface MetricStat {
  /** Samples collected. */
  count: number;
  min: number;
  max: number;
  mean: number;
  /** Median of the most recent window — see the module doc. */
  p50: number;
  /** 95th percentile of the most recent window. */
  p95: number;
}

/**
 * Everything collected so far. A stat is absent until its first sample,
 * never a row of zeroes.
 * @sealed
 * @public
 */
export interface MetricsSummary {
  /** Replies collected. */
  replies: number;
  /** Of those, how many were cut short. */
  interrupted: number;
  /** Committed caller turn → first reply audio. */
  latencyMs?: MetricStat;
  /** Last partial with words → committed final. */
  sttEndpointingMs?: MetricStat;
  /** Request → the model's first content part. */
  llmTtftMs?: MetricStat;
  /** Request → the stream settling. */
  llmDurationMs?: MetricStat;
  /** First text into TTS → its first audio. */
  ttsTtfbMs?: MetricStat;
  /** Totals — sums, not distributions. */
  llmInputTokens: number;
  llmOutputTokens: number;
  llmSteps: number;
  ttsCharacters: number;
}

/**
 * A running summary of `metrics.collected` frames — see
 * {@link createMetricsCollector}.
 * @sealed
 * @public
 */
export interface MetricsCollector {
  /** Fold in one reply's metrics. */
  collect(sample: MetricsSample): void;
  /** The summary so far. A fresh object each call; safe to keep. */
  summary(): MetricsSummary;
  /** Forget everything collected. */
  reset(): void;
}

/** Options for {@link createMetricsCollector}. @public */
export interface MetricsCollectorOptions {
  /**
   * How many recent samples per measurement the percentiles are computed
   * over. Default 1000.
   */
  maxSamples?: number;
}

const DEFAULT_MAX_SAMPLES = 1000;

type Distribution = {
  add(value: number): void;
  stat(): MetricStat | undefined;
};

/** Exact running aggregates plus a ring buffer for the percentiles. */
function createDistribution(maxSamples: number): Distribution {
  let count = 0;
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  const window: number[] = [];
  let next = 0;
  return {
    add(value) {
      count++;
      sum += value;
      if (value < min) min = value;
      if (value > max) max = value;
      if (window.length < maxSamples) window.push(value);
      else window[next] = value;
      next = (next + 1) % maxSamples;
    },
    stat() {
      if (count === 0) return;
      const sorted = [...window].sort((a, b) => a - b);
      return {
        count,
        min,
        max,
        mean: sum / count,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
      };
    },
  };
}

/** Nearest-rank percentile of an already-sorted, non-empty list. */
function percentile(sorted: readonly number[], q: number): number {
  const rank = Math.ceil(q * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))] ?? 0;
}

/**
 * Create a collector — see this module's doc for an example.
 * @public
 */
export function createMetricsCollector(options: MetricsCollectorOptions = {}): MetricsCollector {
  const maxSamples = Math.max(1, Math.floor(options.maxSamples ?? DEFAULT_MAX_SAMPLES));
  let replies = 0;
  let interrupted = 0;
  let llmInputTokens = 0;
  let llmOutputTokens = 0;
  let llmSteps = 0;
  let ttsCharacters = 0;
  let dists = fresh();

  function fresh() {
    return {
      latencyMs: createDistribution(maxSamples),
      sttEndpointingMs: createDistribution(maxSamples),
      llmTtftMs: createDistribution(maxSamples),
      llmDurationMs: createDistribution(maxSamples),
      ttsTtfbMs: createDistribution(maxSamples),
    };
  }

  const addIf = (dist: Distribution, value: number | undefined): void => {
    if (value !== undefined && Number.isFinite(value)) dist.add(value);
  };

  return {
    collect(sample) {
      replies++;
      if (sample.interrupted) interrupted++;
      addIf(dists.latencyMs, sample.latencyMs);
      addIf(dists.sttEndpointingMs, sample.stt?.endpointingMs);
      if (sample.llm) {
        addIf(dists.llmTtftMs, sample.llm.ttftMs);
        addIf(dists.llmDurationMs, sample.llm.durationMs);
        llmSteps += sample.llm.steps;
        llmInputTokens += sample.llm.inputTokens ?? 0;
        llmOutputTokens += sample.llm.outputTokens ?? 0;
      }
      if (sample.tts) {
        addIf(dists.ttsTtfbMs, sample.tts.ttfbMs);
        ttsCharacters += sample.tts.characters;
      }
    },
    summary() {
      const out: MetricsSummary = {
        replies,
        interrupted,
        llmInputTokens,
        llmOutputTokens,
        llmSteps,
        ttsCharacters,
      };
      for (const key of Object.keys(dists) as (keyof typeof dists)[]) {
        const stat = dists[key].stat();
        if (stat !== undefined) out[key] = stat;
      }
      return out;
    },
    reset() {
      replies = 0;
      interrupted = 0;
      llmInputTokens = 0;
      llmOutputTokens = 0;
      llmSteps = 0;
      ttsCharacters = 0;
      dists = fresh();
    },
  };
}
