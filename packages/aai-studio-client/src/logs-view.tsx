// Copyright 2026 the AAI authors. MIT license.
// The Logs pane — what the project's agent has printed, live.
//
// It is a TAIL, not a document: it polls `GET /:slug/logs` by cursor, appends,
// and follows the bottom unless the reader has scrolled away. Everything below
// follows from three properties of the source (aai-server/agent-logs.ts):
//
// - **The ring is bounded and lives in the guest**, so it dies with the
//   sandbox. A pane that presented this as a log FILE would be lying about
//   what it can show; it says so instead, once, in the footer.
// - **`running` is separate from `lines`.** An empty page has two meanings and
//   they need opposite things from the reader — wait, versus go make the agent
//   do something — so the empty state is written from `running`, never from
//   the line count.
// - **`dropped` is reported rather than swallowed.** A gap is rendered as a
//   line of its own, because a tail that silently skips is indistinguishable
//   from an agent that went quiet.

import clsx from "clsx";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { StickToBottom } from "use-stick-to-bottom";
import { type AgentLogLine, type AgentLogsPage, api } from "./api.ts";
import { errorText } from "./api-error.ts";
import { SEG_GROUP, segItemClass } from "./segmented.ts";

/**
 * How often the pane asks for what is new.
 *
 * One second, and the cost is bounded by the cursor rather than by the
 * cadence: a poll that finds nothing transfers an empty page, and the guest's
 * read is a slice of an in-memory array. It is a poll rather than a stream
 * because the source is a RING with a cursor, which a reconnecting stream
 * would have to re-derive anyway — and because the studio's existing SSE route
 * carries workspace state, which is a different lifetime from a sandbox's.
 */
const LOGS_POLL_MS = 1000;

/** Lines the pane keeps. Past this the oldest go — the guest's ring is bounded too. */
const MAX_RENDERED_LINES = 5000;

export type LogsViewProps = {
  bearer: string;
  /** The preview agent's slug, when the project has deployed one. */
  previewSlug: string | undefined;
  /** The published agent's slug, when the project has been published. */
  deployedSlug: string | undefined;
};

/** Which of a project's two agents the pane is tailing. */
type LogsTarget = "preview" | "production";

/** Both, in switcher order. */
const LOGS_TARGETS = ["preview", "production"] as const satisfies readonly LogsTarget[];

const TARGET_LABEL: Record<LogsTarget, string> = {
  preview: "Preview",
  production: "Production",
};

/** A gap the ring evicted before this pane read it. Rendered inline. */
type Gap = { kind: "gap"; seq: number; count: number };
type Row = (AgentLogLine & { kind?: undefined }) | Gap;

/** Hoisted: `timeOf` runs once per rendered row. See {@link LogRow} for what
 * keeps the number of those rows proportional to the new lines in a tick. */
function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function timeOf(at: number): string {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * The tail itself: cursor, rows, liveness, and the poll that fills them.
 *
 * A hook rather than more state in the component, so the pane below is markup
 * and this is the only place that reasons about the ring's contract.
 */
function useLogTail(bearer: string, slug: string | undefined) {
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Held in a ref rather than state: the poll reads it and a change to it must
  // not re-run the effect, which would restart the tail from the ring's start.
  const cursor = useRef(-1);

  // A target switch is a different agent's output, so nothing carries over —
  // including the cursor, whose numbers mean nothing in the other ring.
  useEffect(() => {
    cursor.current = -1;
    setRows([]);
    setRunning(null);
    setError(null);
  }, [slug]);

  const append = useCallback((page: AgentLogsPage) => {
    setRunning(page.running);
    setError(null);
    if (page.dropped === 0 && page.lines.length === 0) return;
    setRows((prev) => {
      const next: Row[] =
        page.dropped > 0
          ? [...prev, { kind: "gap", seq: cursor.current, count: page.dropped }]
          : [...prev];
      next.push(...page.lines);
      return next.length > MAX_RENDERED_LINES ? next.slice(-MAX_RENDERED_LINES) : next;
    });
    cursor.current = page.cursor;
  }, []);

  useEffect(() => {
    if (slug === undefined) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const page = await api.agentLogs(bearer, slug, cursor.current);
        if (live) append(page);
      } catch (err) {
        // A failed poll is not a failed pane: the next tick is a second away,
        // and a transient 503 while a sandbox comes up is the common case. The
        // message is shown so a PERSISTENT failure is not silent.
        if (live) setError(errorText(err) ?? "Could not read logs");
      }
      if (live) timer = setTimeout(() => void poll(), LOGS_POLL_MS);
    };
    void poll();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [bearer, slug, append]);

  return { rows, running, error };
}

export function LogsView(props: LogsViewProps) {
  const { bearer, previewSlug, deployedSlug } = props;
  // Preview is the default because it is what the pane beside it shows: the
  // agent the user is iterating on. Production is a deliberate switch.
  const [target, setTarget] = useState<LogsTarget>("preview");
  const slug = target === "preview" ? previewSlug : deployedSlug;
  const { rows, running, error } = useLogTail(bearer, slug);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-cream">
      <header className="flex flex-none items-center gap-3 border-b border-line bg-panel px-4 py-2">
        <span className="eyebrow">Logs</span>
        <TargetSwitch
          target={target}
          previewSlug={previewSlug}
          deployedSlug={deployedSlug}
          onSelect={setTarget}
        />
        <div className="flex-1" />
        {slug !== undefined && running !== null && <Liveness running={running} />}
      </header>

      {error !== null && (
        <div className="flex-none border-b border-line bg-red-50 px-4 py-1.5 text-[11px] text-err">
          {error}
        </div>
      )}

      {/*
       * Follow the bottom, but only while the reader is there: scrolling up to
       * read something is exactly when a forced scroll is most annoying. That
       * is `use-stick-to-bottom`'s job — the same component the chat transcript
       * mounts — rather than this pane's, and the difference is a ResizeObserver
       * it owns: the hand-rolled version re-pinned only when a LINE arrived, so
       * a line that wrapped, or a monospace font that finished loading, grew the
       * content under a pane that thought it was already at the bottom.
       *
       * `instant` at both ends because this is a tail: a spring animation on a
       * log that appends every second never settles.
       */}
      <StickToBottom className="min-h-0 flex-1" initial="instant" resize="instant">
        <StickToBottom.Content className="px-4 py-3 font-mono text-[11px] leading-[1.6]">
          <LogsBody slug={slug} target={target} rows={rows} running={running} />
        </StickToBottom.Content>
      </StickToBottom>

      <footer className="flex-none border-t border-line bg-panel px-4 py-1.5 text-[10px] text-subtle">
        Recent output only — an agent's log lives in its sandbox and goes when the sandbox does.
      </footer>
    </div>
  );
}

function TargetSwitch(props: {
  target: LogsTarget;
  previewSlug: string | undefined;
  deployedSlug: string | undefined;
  onSelect: (target: LogsTarget) => void;
}) {
  const slugFor = (id: LogsTarget) => (id === "preview" ? props.previewSlug : props.deployedSlug);
  return (
    <div className={SEG_GROUP}>
      {LOGS_TARGETS.map((id, i) => (
        <button
          key={id}
          type="button"
          aria-current={props.target === id ? "page" : undefined}
          disabled={slugFor(id) === undefined}
          className={clsx(
            // Its own size rather than `.seg`: this picker sits in a pane
            // header, not the 60px top bar.
            "px-2.5 py-1 text-[11px]",
            segItemClass(props.target === id, i),
            "disabled:cursor-not-allowed disabled:text-disabled",
          )}
          onClick={() => props.onSelect(id)}
        >
          {TARGET_LABEL[id]}
        </button>
      ))}
    </div>
  );
}

function Liveness(props: { running: boolean }) {
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-muted">
      <span
        aria-hidden
        className={`h-[7px] w-[7px] rounded-full ${props.running ? "bg-indigo" : "bg-line-strong"}`}
      />
      {props.running ? "running" : "not running"}
    </span>
  );
}

/**
 * Rows, or the reason there are none.
 *
 * The two empty states are written from different facts and must not be
 * collapsed: no SLUG means the agent has never been deployed (nothing will
 * ever appear until it is), while `running: false` means it exists and is not
 * up (a request would wake it).
 */
function LogsBody(props: {
  slug: string | undefined;
  target: LogsTarget;
  rows: readonly Row[];
  running: boolean | null;
}) {
  if (props.slug === undefined) {
    return props.target === "preview" ? (
      <Empty
        title="No preview yet"
        body="Your first agent turn deploys a preview. Its output shows up here."
      />
    ) : (
      <Empty
        title="Not published yet"
        body="Publish this project and its production agent's output shows up here."
      />
    );
  }
  if (props.rows.length === 0) {
    return props.running ? (
      <Empty
        title="No output yet"
        body="Anything the agent prints — a console.log in a tool, a stack trace — appears here as it happens."
      />
    ) : (
      <Empty
        title="Nothing running"
        body="The agent's sandbox isn't up. Start a session, or send it a request, and its output appears here."
      />
    );
  }
  return (
    <>
      {props.rows.map((row) => (
        <LogRow key={`${row.kind ?? "line"}-${row.seq}`} row={row} />
      ))}
    </>
  );
}

/**
 * One line, memoized.
 *
 * The tail re-renders on every poll tick — once a second — and holds up to
 * {@link MAX_RENDERED_LINES} rows, so without this a tick that brought one new
 * line re-ran `timeOf` and reconciled all 5000. Row identity is what makes it
 * work: `append` spreads the previous array and pushes the parsed page objects
 * themselves, and `slice` preserves identity, so only genuinely new rows have a
 * new `row` reference. Same pattern and same argument as `MessageView` in
 * chat-transcript.tsx.
 */
const LogRow = memo(function LogRow(props: { row: Row }) {
  const { row } = props;
  if (row.kind === "gap") {
    return (
      <div className="my-1 border-y border-line py-1 text-[10px] text-subtle">
        {row.count} earlier {row.count === 1 ? "line" : "lines"} dropped — the agent printed faster
        than this pane read
      </div>
    );
  }
  return (
    <div className="flex gap-3 whitespace-pre-wrap">
      <span className="flex-none text-subtle tabular-nums">{timeOf(row.at)}</span>
      <span className={row.stream === "stderr" ? "text-err" : "text-fg"}>{row.text}</span>
    </div>
  );
});

function Empty(props: { title: string; body: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-10 font-sans">
      <h2 className="m-0 text-center font-serif text-[20px] font-normal">{props.title}</h2>
      <p className="m-0 max-w-sm text-center text-[13px] leading-5 text-muted">{props.body}</p>
    </div>
  );
}
