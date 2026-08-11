// Copyright 2026 the AAI authors. MIT license.
/**
 * Automatic session analytics — the runtime's own record of what a live
 * session did, emitted with **zero instrumentation from the agent author**.
 *
 * The design rule is that this module never asks the rest of the runtime for
 * anything. Every event here is derived by DECORATING seams that already
 * exist:
 *
 * - {@link SessionAnalytics.wrapSink} wraps the session's {@link ClientSink},
 *   which already carries the complete `ClientEvent` stream (transcripts,
 *   tool calls, errors, cancellations) plus the raw audio frames — and the
 *   audio frames are what make time-to-first-audio measurable at all.
 * - {@link SessionAnalytics.wrapExecuteTool} wraps `ExecuteTool`, the one
 *   funnel every tool call goes through in both self-hosted and relay modes.
 * - {@link SessionAnalytics.wrapLogger} wraps the injected {@link Logger}, so
 *   the runtime's own log lines land in the same store as the metrics and a
 *   spike in one can be read against the other.
 *
 * Nothing here is on the audio path's critical section beyond a push into an
 * array, and every derivation is wrapped so a recorder bug can never take a
 * session down: an analytics failure must cost a missing row, never a call.
 *
 * ## The two clocks
 *
 * `ts` is wall-clock (`Date.now()`) because rows are queried by time of day
 * and joined against deploys. Durations are measured with the SAME clock
 * rather than `performance.now()`, deliberately: the events are shipped to a
 * different process and stored, so a monotonic reading with no epoch would
 * have to be rebased anyway, and a duration that disagrees with the two
 * timestamps around it is worse than one that inherits their (millisecond)
 * jitter.
 */

import type { ExecuteTool } from "../sdk/agent-config.ts";
import type { ClientEvent, ClientSink } from "../sdk/protocol.ts";
import type { Logger, LogLevel } from "./runtime-config.ts";

/**
 * The kinds of row the runtime emits. Deliberately a small closed set: the
 * studio documents these to a coding agent writing ad-hoc SQL, and a kind it
 * cannot enumerate is a kind it cannot query.
 */
export type AnalyticsEventKind =
  | "session_start"
  | "session_end"
  | "user_turn"
  | "agent_turn"
  | "tool_call"
  | "barge_in"
  | "error"
  | "log";

/**
 * One analytics row, flat on purpose — it maps 1:1 onto the platform's
 * `aai_platform.agent_events` columns, so the shape an agent queries is the
 * shape the runtime emits and there is no translation layer to drift.
 */
export type AnalyticsEvent = {
  /** Wall-clock milliseconds when the event happened. */
  ts: number;
  /** The runtime session id — the join key for reconstructing a conversation. */
  sessionId: string;
  kind: AnalyticsEventKind;
  /** 1-based user turn ordinal; 0 for anything before the first user turn. */
  turn: number;
  /** Elapsed milliseconds, for the kinds that measure something. */
  durationMs?: number | undefined;
  /** Log level, for `log` rows. */
  level?: LogLevel | undefined;
  /** Tool name, error code, or log-line message subject. */
  name?: string | undefined;
  /** Transcript text, error message, or log message. Truncated. */
  text?: string | undefined;
  /** Did it succeed? Tool calls, and agent turns that were not interrupted. */
  ok?: boolean | undefined;
  /** Everything kind-specific. Small by construction — see the caps below. */
  data?: Record<string, unknown> | undefined;
};

/** Where finished events go. The guest ships them; tests collect them. */
export type AnalyticsSink = {
  record(event: AnalyticsEvent): void;
};

/**
 * Caps. Transcripts and log context are unbounded in principle and this is
 * the highest-write path the platform has, so both are clamped HERE rather
 * than at the store: a row that is truncated on arrival still cost the
 * network hop, and the guest's buffer is memory in a memory-capped sandbox.
 */
const MAX_TEXT_CHARS = 2000;
const MAX_DATA_CHARS = 1000;

function clip(text: string, max = MAX_TEXT_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * Log context, reduced to something a jsonb column should hold: primitives
 * kept, everything else stringified and clipped. A logger call site is free
 * to pass whatever it likes, and several pass error objects.
 */
function clipData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === null || typeof value !== "object") {
      out[key] = typeof value === "string" ? clip(value, MAX_DATA_CHARS) : value;
      continue;
    }
    try {
      out[key] = clip(JSON.stringify(value) ?? "", MAX_DATA_CHARS);
    } catch {
      out[key] = "[unserializable]";
    }
  }
  return out;
}

export type SessionAnalyticsOptions = {
  sink: AnalyticsSink;
  sessionId: string;
  /** The agent's name, stamped on `session_start` so a row set is self-describing. */
  agent: string;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
};

/** The per-session recorder. One per live session; created by the runtime. */
export type SessionAnalytics = {
  /** Record `session_start`. Call once, when the session is created. */
  start(): void;
  /** Record `session_end` with the session's wall-clock duration. Idempotent. */
  end(reason?: string): void;
  /** Decorate the client sink so events and audio frames are observed. */
  wrapSink(client: ClientSink): ClientSink;
  /** Decorate `ExecuteTool` so every tool call is timed and its outcome recorded. */
  wrapExecuteTool(execute: ExecuteTool): ExecuteTool;
  /** Decorate a logger so its lines land beside the metrics. */
  wrapLogger(logger: Logger): Logger;
};

/**
 * A tool result is a STRING on this seam — the host serializes before it
 * returns — so success is read back off the wire format `toolError` writes.
 * That is deliberately not `isToolFailure`: this sees `toolError`'s
 * pre-serialized `'{"error":"…"}'`, which that guard returns false for (see
 * `sdk/utils.ts`). Getting this backwards would report every failure as a
 * success, which is the one thing a reliability metric must not do.
 */
function resultLooksOk(result: string): boolean {
  if (!result.startsWith("{")) return true;
  try {
    const parsed: unknown = JSON.parse(result);
    return !(parsed !== null && typeof parsed === "object" && "error" in parsed);
  } catch {
    return true;
  }
}

/**
 * Build the recorder for one session.
 *
 * The reply-latency derivation is the part worth reading. A voice turn's
 * quality metric is **time to first audio** — how long the caller waited in
 * silence after they stopped talking — and neither end of it is reported by
 * anything: the start is the committed `user_transcript`, and the end is the
 * first PCM frame pushed at the sink. Both cross this decorator, so the
 * measurement needs no new plumbing anywhere else.
 */
export function createSessionAnalytics(opts: SessionAnalyticsOptions): SessionAnalytics {
  const { sink, sessionId, agent } = opts;
  const now = opts.now ?? Date.now;
  const sessionStart = now();

  let turn = 0;
  let ended = false;
  /** When the user's turn committed — the anchor for this reply's latency. */
  let turnAt: number | null = null;
  /** Time to first audio for the reply in flight; null until the frame lands. */
  let firstAudioMs: number | null = null;
  /** Latest agent transcript snapshot (they are replacements, not appends). */
  let replyText = "";
  /** Was the agent audible when the reply was cancelled? Decides barge-in. */
  let spoke = false;
  let endReason: string | undefined;
  let errorCount = 0;
  let toolCount = 0;

  /**
   * Never let a recorder bug reach the session. Every public entry point is
   * routed through this — the decorators sit on the audio and tool paths, so
   * a throw here would take down the call it was only supposed to observe.
   */
  function safely(fn: () => void): void {
    try {
      fn();
    } catch {
      /* analytics must not break a session */
    }
  }

  function record(event: AnalyticsEvent): void {
    sink.record(event);
  }

  function base(kind: AnalyticsEventKind): AnalyticsEvent {
    return { ts: now(), sessionId, kind, turn };
  }

  /** Close out the reply in flight, if any. Shared by `reply_done`/`cancelled`. */
  function settleReply(interrupted: boolean): void {
    if (turnAt === null) return;
    const at = turnAt;
    turnAt = null;
    record({
      ...base("agent_turn"),
      durationMs: now() - at,
      ok: !interrupted,
      text: replyText ? clip(replyText) : undefined,
      data: {
        // Absent rather than zero when no audio was ever sent: a turn that
        // produced nothing has no latency, and averaging a zero into the
        // percentiles is how a broken agent looks fast.
        ...(firstAudioMs === null ? {} : { firstAudioMs }),
        ...(interrupted ? { interrupted: true } : {}),
      },
    });
    if (interrupted && spoke) {
      record({ ...base("barge_in"), durationMs: now() - at });
    }
    replyText = "";
    firstAudioMs = null;
    spoke = false;
  }

  function observe(event: ClientEvent): void {
    switch (event.type) {
      case "user_transcript": {
        // A new user turn while a reply is still open means that reply never
        // formally finished (an S2S provider that just moves on). Settle it
        // rather than losing it, so turns and replies stay paired.
        settleReply(false);
        turn += 1;
        turnAt = now();
        record({ ...base("user_turn"), text: clip(event.text) });
        break;
      }
      case "agent_transcript":
        replyText = event.text;
        break;
      case "reply_done":
        settleReply(false);
        break;
      case "cancelled":
        settleReply(true);
        break;
      case "error":
        errorCount += 1;
        record({
          ...base("error"),
          name: event.code,
          text: clip(event.message),
          ok: false,
          data: { fatal: event.fatal ?? true },
        });
        break;
      case "idle_timeout":
        endReason = "idle_timeout";
        break;
      default:
        // speech edges, partials, agent_state, custom events, tool frames:
        // deliberately not rows. Partials alone would outnumber every other
        // kind by two orders of magnitude, and the tool frames are recorded
        // at the executor seam below, where the DURATION is knowable.
        break;
    }
  }

  return {
    start() {
      safely(() => {
        record({ ...base("session_start"), name: agent });
      });
    },

    end(reason) {
      safely(() => {
        if (ended) return;
        ended = true;
        // A session torn down mid-reply still owes an `agent_turn` row —
        // without this, every hang-up-while-the-agent-is-talking session is
        // simply missing its last turn, which is the turn worth looking at.
        settleReply(true);
        record({
          ...base("session_end"),
          durationMs: now() - sessionStart,
          name: reason ?? endReason,
          data: { turns: turn, errors: errorCount, tools: toolCount },
        });
      });
    },

    wrapSink(client) {
      return {
        get open(): boolean {
          return client.open;
        },
        event(e) {
          safely(() => observe(e));
          client.event(e);
        },
        playAudioChunk(chunk) {
          safely(() => {
            spoke = true;
            if (firstAudioMs === null && turnAt !== null) firstAudioMs = now() - turnAt;
          });
          client.playAudioChunk(chunk);
        },
        playAudioDone() {
          client.playAudioDone();
        },
        ...(client.close ? { close: (reason?: string) => client.close?.(reason) } : {}),
      };
    },

    wrapExecuteTool(execute) {
      return async (name, args, sid, messages, execOpts) => {
        const startedAt = now();
        let result: string;
        try {
          result = await execute(name, args, sid, messages, execOpts);
        } catch (err) {
          safely(() => {
            toolCount += 1;
            record({
              ...base("tool_call"),
              durationMs: now() - startedAt,
              name,
              ok: false,
              text: clip(err instanceof Error ? err.message : String(err)),
            });
          });
          throw err;
        }
        safely(() => {
          toolCount += 1;
          record({
            ...base("tool_call"),
            durationMs: now() - startedAt,
            name,
            ok: resultLooksOk(result),
            text: clip(result),
          });
        });
        return result;
      };
    },

    wrapLogger(logger) {
      // `debug` is passed through unrecorded: it is off unless AAI_DEBUG is
      // set, and it is per-audio-frame in places.
      const wrap =
        (level: LogLevel) =>
        (msg: string, ctx?: Record<string, unknown>): void => {
          safely(() => {
            record({
              ...base("log"),
              level,
              text: clip(msg),
              ...(ctx ? { data: clipData(ctx) } : {}),
            });
          });
          logger[level](msg, ctx);
        };
      return {
        info: wrap("info"),
        warn: wrap("warn"),
        error: wrap("error"),
        debug: logger.debug,
      };
    },
  };
}
