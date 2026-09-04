import { plural } from "@alexkroman1/aai/utils";
import "@alexkroman1/aai-ui/styles.css";
import type { AgentState, ConversationItem } from "@alexkroman1/aai-ui";
import {
  AGENT_STATE_LABELS,
  AutoScroll,
  mountClient,
  SessionErrorBanner,
  useAgentState,
  useConversation,
  useSessionActions,
  useSessionSelector,
  useSessionStatus,
} from "@alexkroman1/aai-ui";
import type { DispatchState, IncidentSummary, Severity, Status } from "./shared.ts";
import { dashboardProjection } from "./shared.ts";

const CSS = `
@keyframes dc-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
@keyframes dc-slide-in {
  from { transform: translateY(10px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}
.dc-messages::-webkit-scrollbar { width: 6px; }
.dc-messages::-webkit-scrollbar-track { background: transparent; }
.dc-messages::-webkit-scrollbar-thumb { background: #334155; border-radius: 3px; }
.dc-sidebar::-webkit-scrollbar { width: 6px; }
.dc-sidebar::-webkit-scrollbar-track { background: transparent; }
.dc-sidebar::-webkit-scrollbar-thumb { background: #334155; border-radius: 3px; }
@media (max-width: 900px) {
  .dc-main { grid-template-columns: 1fr !important; grid-template-rows: auto 1fr !important; }
}
`;

// Each color map is `satisfies`-pinned to the shared union it renders, so a
// renamed or added level/severity/status is a compile error here instead of
// a silently gray badge.
const alertColors: Record<string, string> = {
  green: "#22c55e",
  yellow: "#eab308",
  orange: "#f97316",
  red: "#ef4444",
} satisfies Record<DispatchState["alertLevel"], string>;

const severityColors: Record<string, string> = {
  critical: "#ef4444",
  urgent: "#f97316",
  moderate: "#eab308",
  minor: "#22c55e",
} satisfies Record<Severity, string>;

const statusColors: Record<string, string> = {
  incoming: "#818cf8",
  triaged: "#a78bfa",
  dispatched: "#f59e0b",
  en_route: "#3b82f6",
  on_scene: "#22c55e",
  resolved: "#6b7280",
  escalated: "#ef4444",
} satisfies Record<Status, string>;

// The dot's colour per session state, as an EXHAUSTIVE map rather than an
// if-chain with a grey default.
//
// The palette is this template's own — every client here paints the same six
// states in its own colours, so the SDK has nothing to share but the union. What
// the SDK does own is `AgentState`, and `satisfies Record<AgentState, string>`
// is what borrows it: a state added there stops compiling here, where the
// `state === "…"` chain this replaced answered a new state with a silent grey
// badge in three separate files and no way to notice.
const STATE_COLORS = {
  disconnected: "#6b7280",
  connecting: "#6b7280",
  ready: "#22c55e",
  listening: "#22c55e",
  thinking: "#eab308",
  speaking: "#3b82f6",
  error: "#6b7280",
} satisfies Record<AgentState, string>;

/*
 * The board's own vocabulary, spread over the package's record rather than
 * written as a ternary chain. Only three of the seven states get a dispatch
 * word; the rest come from `AGENT_STATE_LABELS`, so a state added upstream
 * reads as something rather than falling through to whichever arm the chain
 * ended on.
 */
const STATE_LABELS: Record<AgentState, string> = {
  ...AGENT_STATE_LABELS,
  listening: "LISTENING",
  thinking: "PROCESSING",
  speaking: "TRANSMITTING",
};

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg p-3" style={{ background: "#1a1a2e", border: "1px solid #1e293b" }}>
      <div
        className="text-[10px] font-bold uppercase tracking-[1.5px] mb-2.5"
        style={{ color: "#64748b" }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function StatRow({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="flex justify-between items-center py-1 text-xs">
      <span style={{ color: "#94a3b8" }}>{label}</span>
      <span className="font-bold" style={{ color: color ?? "#e2e8f0" }}>
        {value}
      </span>
    </div>
  );
}

function IncidentCard({ inc }: { inc: IncidentSummary }) {
  const sevColor = severityColors[inc.severity] || "#334155";
  return (
    <div
      className="rounded-md p-2.5 mb-2"
      style={{
        background: "#0f172a",
        animation: "dc-slide-in 0.3s ease-out",
        border: `1px solid ${sevColor}40`,
        borderLeft: `3px solid ${sevColor}`,
      }}
    >
      <div className="flex justify-between items-center mb-1">
        <span className="text-xs font-bold" style={{ color: "#f1f5f9" }}>
          {inc.id}
        </span>
        <span
          className="text-[9px] px-1.5 py-0.5 rounded font-bold uppercase"
          style={{ background: `${sevColor}30`, color: sevColor }}
        >
          {inc.severity}
        </span>
      </div>
      {inc.location && (
        <div className="text-[11px] mb-0.5" style={{ color: "#94a3b8" }}>
          {inc.location}
        </div>
      )}
      <div
        className="text-[10px] uppercase tracking-wider"
        style={{ color: statusColors[inc.status] || "#6b7280" }}
      >
        {inc.status.replace("_", " ")}
      </div>
    </div>
  );
}

/** One radio line: a message bubble, or the tool call that came after it. */
function Row({ item }: { item: ConversationItem }) {
  if (item.kind === "tool") {
    const { name, status } = item.toolCall;
    return (
      <div
        className="self-start rounded-md px-2.5 py-1.5 text-[11px] font-mono flex items-center gap-2"
        style={{
          background: "#111827",
          border: "1px solid #1e293b",
          color: status === "pending" ? "#eab308" : "#64748b",
        }}
      >
        <span
          className="w-1.5 h-1.5 rounded-full inline-block"
          style={{
            background: status === "pending" ? "#eab308" : "#22c55e",
            animation: status === "pending" ? "dc-pulse 1s ease-in-out infinite" : "none",
          }}
        />
        {name}
      </div>
    );
  }
  const { role, content } = item.message;
  return (
    <div
      className="rounded-lg text-[13px] max-w-[85%] px-3.5 py-2.5"
      style={{
        lineHeight: 1.6,
        alignSelf: role === "assistant" ? "flex-start" : "flex-end",
        background: role === "assistant" ? "#1e293b" : "#172554",
        animation: "dc-slide-in 0.2s ease-out",
        borderLeft: role === "assistant" ? "3px solid #3b82f6" : "none",
        borderRight: role !== "assistant" ? "3px solid #22d3ee" : "none",
      }}
    >
      <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: "#64748b" }}>
        {role === "assistant" ? "DISPATCH" : "OPERATOR"}
      </div>
      {content}
    </div>
  );
}

/**
 * The radio log.
 *
 * `useConversation()` rather than a `session.messages.map(...)`: the messages
 * were only half of it. This board runs eight tools and rendered NONE of them,
 * because tool calls live in a second array this page never read — and it also
 * dropped the streaming reply and the thinking indicator. The hook owns the
 * interleave (a tool row follows its anchor message), the `null`-vs-`""`
 * transcript distinction and the thinking-suppression rule; what stays here is
 * the markup, which is the part this template exists to show.
 *
 * It also subscribes per FIELD, so the conversation re-renders at the
 * conversation's rate. The whole-page `useSession()` this replaced re-rendered
 * the incident board on every STT partial.
 */
function Conversation() {
  const { items, streaming, transcript, thinking } = useConversation();
  return (
    <>
      <AutoScroll
        scrollClassName="dc-messages overflow-y-auto"
        contentClassName="p-4 flex flex-col gap-2"
      >
        {items.length === 0 && !streaming && (
          <div className="text-center p-10 text-[13px]" style={{ color: "#475569" }}>
            Dispatch Command Center standing by. Click START to begin operations.
          </div>
        )}
        {items.map((item) => (
          <Row
            key={item.kind === "message" ? `m${item.message.id}` : item.toolCall.callId}
            item={item}
          />
        ))}
        {streaming !== null && (
          <div
            className="rounded-lg text-[13px] max-w-[85%] px-3.5 py-2.5 self-start"
            style={{ lineHeight: 1.6, background: "#1e293b", borderLeft: "3px solid #3b82f6" }}
          >
            <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: "#64748b" }}>
              DISPATCH
            </div>
            {streaming}
          </div>
        )}
        {/* Same contract as the shipped `MessageList`'s indicator: three pulsing
            dots are the only sign the desk is working, and to a screen reader
            they are punctuation. */}
        {thinking && (
          <div
            role="status"
            aria-label="Dispatch is thinking"
            className="self-start text-[11px] px-3.5"
            style={{ color: "#64748b" }}
          >
            <span style={{ animation: "dc-pulse 1.2s ease-in-out infinite" }}>· · ·</span>
          </div>
        )}
      </AutoScroll>

      {transcript.speaking && (
        <div
          className="flex items-center px-4 py-2 text-xs italic min-h-8"
          style={{ background: "#111827", borderTop: "1px solid #1e293b", color: "#64748b" }}
        >
          <span
            className="w-2.5 h-2.5 rounded-full inline-block mr-2"
            style={{ background: "#22c55e", animation: "dc-pulse 1.5s ease-in-out infinite" }}
          />
          {transcript.text}
        </div>
      )}
    </>
  );
}

/**
 * The live status readout, on its own subscription.
 *
 * `useSessionSelector` rather than a field off a whole-page `useSession()`: the
 * header is the only thing here that cares about the session state, and reading
 * it one level up dragged the incident board through every snapshot change.
 */
function StatusReadout() {
  const state = useSessionStatus();
  return (
    <>
      <span
        className="w-2.5 h-2.5 rounded-full inline-block"
        style={{
          background: STATE_COLORS[state],
          animation:
            state === "listening"
              ? "dc-pulse 1.5s ease-in-out infinite"
              : state === "thinking"
                ? "dc-pulse 0.8s ease-in-out infinite"
                : "none",
        }}
        title={state}
      />
      <span className="text-[11px] font-normal normal-case" style={{ color: "#64748b" }}>
        {STATE_LABELS[state]}
      </span>
    </>
  );
}

/*
 * The shift controls.
 *
 * `useSessionActions()` for the methods and two one-field selectors for the
 * flags, rather than the whole-snapshot `useSession()` this used to hold. The
 * methods are what the row is really after, and `useSession()` re-renders on
 * every snapshot change — so four buttons re-rendered at STT-partial rate to
 * read two booleans that flip once a shift.
 */
function ShiftControls({ logged }: { logged: number }) {
  const { start, toggle, restart, end } = useSessionActions();
  const started = useSessionSelector((s) => s.started);
  const running = useSessionSelector((s) => s.running);
  return (
    <div
      className="flex items-center gap-2.5 px-4 py-3"
      style={{ background: "#111827", borderTop: "1px solid #1e293b" }}
    >
      {!started ? (
        <button
          type="button"
          className="px-4 py-2 border-none rounded-md font-mono text-xs font-semibold uppercase tracking-wider cursor-pointer text-white"
          style={{ background: "#2563eb" }}
          onClick={() => start()}
        >
          Start Dispatch
        </button>
      ) : (
        <>
          <button
            type="button"
            className="px-4 py-2 border-none rounded-md font-mono text-xs font-semibold uppercase tracking-wider cursor-pointer"
            style={{
              background: running ? "#334155" : "#2563eb",
              color: running ? "#e2e8f0" : "white",
            }}
            onClick={() => toggle()}
          >
            {running ? "Pause" : "Resume"}
          </button>
          {/* The one-click new conversation the default shell's
              `<Controls>` gives every other template — a custom
              `component:` renders no `<Controls>`, so a console like
              this one has to say it itself.

              end() then start(), NOT reset(): reset() clears the
              conversation and leaves the agent's own session-scoped
              state behind, so the next tool call would repopulate the
              shift that was just abandoned. end() drops the resume
              identity, so the redial is a brand-new session (fresh
              incident board, greeting included), and start() puts the
              console straight back on the call rather than at the
              "Start Dispatch" screen. */}
          <button
            type="button"
            className="px-4 py-2 border-none rounded-md font-mono text-xs font-semibold uppercase tracking-wider cursor-pointer"
            style={{ background: "#1e293b", color: "#e2e8f0" }}
            onClick={restart}
          >
            New Conversation
          </button>
          {/* end() hangs up and flips `started` back, so the UI
              returns to "Start Dispatch" and the next start is a
              brand-new shift (fresh incident board, greeting
              included). reset() would keep the call live — the
              buttons never toggle back. */}
          <button
            type="button"
            className="px-4 py-2 border-none rounded-md font-mono text-xs font-semibold uppercase tracking-wider cursor-pointer text-white"
            style={{ background: "#dc2626" }}
            onClick={() => end()}
          >
            End Shift
          </button>
        </>
      )}
      <div className="flex-1" />
      <span className="text-[10px]" style={{ color: "#475569" }}>
        {logged} {plural(logged, "incident")} logged
      </span>
    </div>
  );
}

function App() {
  // The agent's own board, projected by `syncState`. This replaced a
  // useState mirror that merged incident deltas out of tool events — the
  // projection is already the complete list, so there is nothing to merge.
  //
  // It is the ONLY subscription at this level: the session reads that used to
  // sit beside it moved into the four components above, so a partial transcript
  // no longer re-renders the incident cards.
  const dash = useAgentState(dashboardProjection);

  const incidentList = [...dash.incidents].reverse();
  const activeIncidents = incidentList.filter((i) => i.status !== "resolved");
  const resolvedCount = incidentList.filter((i) => i.status === "resolved").length;

  const alertLevel = dash.systemAlertLevel;
  const alertBg = alertColors[alertLevel] || "#6b7280";
  const alertTextColor = alertLevel === "yellow" ? "#000" : "#fff";

  return (
    <>
      <style>{CSS}</style>
      <div
        className="flex flex-col min-h-screen m-0 p-0 font-mono"
        style={{ background: "#0a0a0f", color: "#e2e8f0" }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-6 py-4 gap-4 flex-wrap shrink-0"
          style={{
            background: "linear-gradient(135deg, #1a1a2e, #16213e)",
            borderBottom: "1px solid #1e293b",
          }}
        >
          <div
            className="flex items-center gap-2.5 text-lg font-bold uppercase tracking-wider"
            style={{ color: "#f1f5f9" }}
          >
            <span style={{ color: "#3b82f6" }}>&#9670;</span>
            Dispatch Command Center
            <StatusReadout />
          </div>
          <div className="flex gap-2 items-center">
            <span className="text-[10px] tracking-wider" style={{ color: "#64748b" }}>
              SYSTEM ALERT:
            </span>
            <span
              className="px-3 py-1 rounded text-[11px] font-bold uppercase tracking-wider"
              style={{
                background: alertBg,
                color: alertTextColor,
                animation: alertLevel === "red" ? "dc-pulse 1s ease-in-out infinite" : "none",
              }}
            >
              {alertLevel.toUpperCase()}
            </span>
          </div>
        </div>

        {/* Main content */}
        <div
          className="dc-main flex-1 grid overflow-hidden"
          style={{ gridTemplateColumns: "1fr 320px" }}
        >
          {/* Left: conversation feed */}
          <div
            className="flex flex-col overflow-hidden"
            style={{ borderRight: "1px solid #1e293b" }}
          >
            <Conversation />
            <SessionErrorBanner className="rounded-none border-x-0 border-b-0" />
            <ShiftControls logged={incidentList.length} />
          </div>

          {/* Right: sidebar dashboard */}
          <div
            className="dc-sidebar overflow-y-auto p-4 flex flex-col gap-4"
            style={{ background: "#111827" }}
          >
            <Panel title="Operations Summary">
              <StatRow
                label="Active Incidents"
                value={activeIncidents.length}
                color={activeIncidents.length > 3 ? "#ef4444" : "#e2e8f0"}
              />
              <StatRow label="Resolved" value={resolvedCount} color="#22c55e" />
              <StatRow label="Total Logged" value={incidentList.length} />
            </Panel>

            <Panel title="Active Incidents">
              {activeIncidents.length === 0 ? (
                <div className="text-xs text-center py-2" style={{ color: "#475569" }}>
                  No active incidents
                </div>
              ) : (
                activeIncidents.map((inc) => <IncidentCard key={inc.id} inc={inc} />)
              )}
            </Panel>

            <Panel title="Severity Legend">
              {Object.entries(severityColors).map(([sev, color]) => (
                <div key={sev} className="flex items-center gap-2 py-0.5">
                  <span className="w-2.5 h-2.5 rounded-sm" style={{ background: color }} />
                  <span className="text-[11px] capitalize" style={{ color: "#94a3b8" }}>
                    {sev}
                  </span>
                </div>
              ))}
            </Panel>

            <Panel title="Training Scenarios">
              <div className="text-[11px] leading-relaxed" style={{ color: "#64748b" }}>
                Say "run mass casualty scenario" or "simulate active shooter" to test dispatch
                operations with complex multi-incident drills.
              </div>
            </Panel>
          </div>
        </div>
      </div>
    </>
  );
}

mountClient({
  component: App,
  theme: {
    bg: "#0a0a0f",
    primary: "#3b82f6",
    text: "#e2e8f0",
    surface: "#1a1a2e",
    border: "#1e293b",
  },
});
