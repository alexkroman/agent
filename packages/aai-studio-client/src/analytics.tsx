// Copyright 2026 the AAI authors. MIT license.
// The Analytics pane — how the project's deployed agents actually behave with
// real callers, over the last 7 days (the full retention window).
//
// The pane answers the questions everyone has, in the order they have them:
// is anyone using it (sessions), is it fast (time to first audio — the
// silence a caller sits through, which is THE voice metric), is it working
// (errors, tool failures), and what happened (recent sessions, log tail).
// Anything past that is a query, not a chart: ask the agent in chat, which
// has the same data over SQL via `query_analytics`.
//
// Two states must never look alike, which is most of the conditional logic
// here: a deployment with analytics switched off, and an agent nobody has
// called. Rendering zeroes for the first would tell a user their agent has no
// users, which is a lie that looks like data.

import { useQuery } from "@tanstack/react-query";
import { type AnalyticsSummary, api } from "./api.ts";
import { errorText } from "./api-error.ts";
import { queryKeys } from "./query-keys.ts";

/** Milliseconds as a short human string. */
function ms(value: number | null): string {
  if (value === null) return "—";
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`;
}

/** A session length, where minutes are the unit people think in. */
function duration(value: number | null): string {
  if (value === null) return "—";
  if (value < 60_000) return `${Math.round(value / 1000)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function timeOfDay(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Stat(props: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-line bg-cream px-3 py-2">
      <span className="text-[11px] uppercase tracking-wide text-subtle">{props.label}</span>
      <span className="font-mono text-lg leading-none text-fg">{props.value}</span>
      {props.hint && <span className="text-[11px] text-muted">{props.hint}</span>}
    </div>
  );
}

function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="m-0 text-[13px] font-medium text-fg">{props.title}</h3>
      {props.children}
    </section>
  );
}

const EMPTY = <p className="m-0 text-[13px] text-muted">Nothing yet.</p>;

/**
 * The per-day bars. A dependency-free sparkline: the shape is the whole
 * point (is traffic growing, did it stop), and a charting library for seven
 * numbers would be the largest thing in this bundle.
 */
function DailyBars(props: { daily: AnalyticsSummary["daily"] }) {
  const peak = Math.max(1, ...props.daily.map((d) => d.sessions));
  if (props.daily.length === 0) return EMPTY;
  return (
    <ol className="m-0 flex list-none items-end gap-1 p-0" aria-label="Sessions per day">
      {props.daily.map((day) => (
        <li key={day.day} className="flex flex-1 flex-col items-center gap-1">
          <span
            className="w-full rounded-sm bg-fg/80"
            // Inline height because the value is data, not a style choice.
            style={{ height: `${Math.max(2, (day.sessions / peak) * 48)}px` }}
            title={`${day.day}: ${day.sessions} sessions, ${day.turns} turns, ${day.errors} errors`}
          />
          <span className="text-[10px] text-subtle">{day.day.slice(5)}</span>
        </li>
      ))}
    </ol>
  );
}

function ToolTable(props: { tools: AnalyticsSummary["tools"] }) {
  if (props.tools.length === 0) return EMPTY;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-subtle">
            <th className="py-1 pr-3 font-normal">Tool</th>
            <th className="py-1 pr-3 text-right font-normal">Calls</th>
            <th className="py-1 pr-3 text-right font-normal">Failures</th>
            <th className="py-1 pr-3 text-right font-normal">p50</th>
            <th className="py-1 text-right font-normal">p95</th>
          </tr>
        </thead>
        <tbody>
          {props.tools.map((tool) => (
            <tr key={tool.name} className="border-t border-line">
              <td className="py-1 pr-3 font-mono">{tool.name}</td>
              <td className="py-1 pr-3 text-right tabular-nums">{tool.calls}</td>
              <td
                className={`py-1 pr-3 text-right tabular-nums ${tool.errors > 0 ? "text-err" : ""}`}
              >
                {tool.errors}
              </td>
              <td className="py-1 pr-3 text-right tabular-nums">{ms(tool.p50Ms)}</td>
              <td className="py-1 text-right tabular-nums">{ms(tool.p95Ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LogTail(props: { logs: AnalyticsSummary["logs"] }) {
  if (props.logs.length === 0) return EMPTY;
  return (
    <ol className="m-0 flex max-h-64 list-none flex-col overflow-y-auto rounded-md border border-line p-0 font-mono text-[12px]">
      {props.logs.map((line) => (
        <li
          key={`${line.ts}-${line.sessionId}-${line.message}`}
          className="flex gap-2 border-b border-line px-2 py-1 last:border-b-0"
        >
          <span className="shrink-0 text-subtle">{timeOfDay(line.ts)}</span>
          <span
            className={`shrink-0 uppercase ${line.level === "error" || line.level === "warn" ? "text-err" : "text-muted"}`}
          >
            {line.level}
          </span>
          <span className="break-all text-fg">{line.message}</span>
        </li>
      ))}
    </ol>
  );
}

function SessionTable(props: { sessions: AnalyticsSummary["recentSessions"] }) {
  if (props.sessions.length === 0) return EMPTY;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-subtle">
            <th className="py-1 pr-3 font-normal">Started</th>
            <th className="py-1 pr-3 text-right font-normal">Length</th>
            <th className="py-1 pr-3 text-right font-normal">Turns</th>
            <th className="py-1 pr-3 text-right font-normal">Errors</th>
            <th className="py-1 font-normal">Ended</th>
          </tr>
        </thead>
        <tbody>
          {props.sessions.map((session) => (
            <tr key={session.sessionId} className="border-t border-line">
              <td className="py-1 pr-3">{timeOfDay(session.startedAt)}</td>
              <td className="py-1 pr-3 text-right tabular-nums">{duration(session.durationMs)}</td>
              <td className="py-1 pr-3 text-right tabular-nums">{session.turns}</td>
              <td
                className={`py-1 pr-3 text-right tabular-nums ${session.errors > 0 ? "text-err" : ""}`}
              >
                {session.errors}
              </td>
              <td className="py-1 text-muted">{session.endReason ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AnalyticsPane(props: { bearer: string; project: string | null }) {
  const { bearer, project } = props;
  const analytics = useQuery({
    queryKey: queryKeys.analytics(project ?? ""),
    queryFn: () => api.getAnalytics(bearer, project ?? ""),
    enabled: Boolean(project),
    // Traffic arrives while the pane is open, and the rows are shipped on a
    // few-second flush — but nothing PUSHES analytics (the workspace SSE
    // stream carries workspace changes, and a call is not one). A slow poll
    // is the honest mechanism; the manual refresh below covers impatience.
    refetchInterval: 30_000,
  });

  if (!project) return null;

  const body = (): React.ReactNode => {
    if (analytics.isPending) {
      return <p className="m-0 text-[13px] text-muted">Loading…</p>;
    }
    if (analytics.isError) {
      return <p className="m-0 text-[13px] text-err">{errorText(analytics.error)}</p>;
    }
    const data = analytics.data;
    if (data.unavailable) {
      return <p className="m-0 text-[13px] text-muted">{data.unavailable}</p>;
    }
    if (data.slugs.length === 0) {
      return (
        <p className="m-0 text-[13px] text-muted">
          No deployed agent yet. Analytics start once this project has a preview or published agent
          and someone talks to it.
        </p>
      );
    }
    return (
      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Sessions" value={String(data.sessions.count)} hint="last 7 days" />
          <Stat
            label="Median call"
            value={duration(data.sessions.medianDurationMs)}
            hint={`${data.sessions.totalTurns} turns total`}
          />
          <Stat
            label="Reply latency p50"
            value={ms(data.turns.p50FirstAudioMs)}
            hint="caller stops → first audio"
          />
          <Stat
            label="Reply latency p95"
            value={ms(data.turns.p95FirstAudioMs)}
            hint={`${data.turns.interrupted} of ${data.turns.count} interrupted`}
          />
        </div>

        <Section title="Sessions per day">
          <DailyBars daily={data.daily} />
        </Section>

        <Section title="Tools">
          <ToolTable tools={data.tools} />
        </Section>

        <Section title="Errors">
          {data.errors.length === 0 ? (
            <p className="m-0 text-[13px] text-muted">None in the last {data.windowDays} days.</p>
          ) : (
            <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
              {data.errors.map((error) => (
                <li
                  key={error.name}
                  className="rounded-md border border-line bg-cream px-2 py-1 text-[13px]"
                >
                  <span className="font-mono">{error.name}</span>{" "}
                  <span className="text-err tabular-nums">{error.count}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Recent sessions">
          <SessionTable sessions={data.recentSessions} />
        </Section>

        <Section title="Logs">
          <LogTail logs={data.logs} />
        </Section>

        {data.sampled && (
          <p className="m-0 text-[11px] text-muted">
            This project has more events than one view can read — the numbers above cover the most
            recent ones. Ask in chat for an exact figure; the agent can query the full window.
          </p>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-5">
      <header className="flex items-baseline justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-sm font-medium text-fg">Analytics</h2>
          <p className="m-0 text-[13px] text-muted">
            Live sessions from this project's preview and published agents, last 7 days. Ask in chat
            for anything not shown here — the agent can query it.
          </p>
        </div>
        <button
          type="button"
          className="btn shrink-0"
          onClick={() => void analytics.refetch()}
          disabled={analytics.isFetching}
        >
          {analytics.isFetching ? "Refreshing…" : "Refresh"}
        </button>
      </header>
      {body()}
    </div>
  );
}
