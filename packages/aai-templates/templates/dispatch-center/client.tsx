/** @jsxImportSource react */

import type { ChatMessage } from "aai-ui";
import { client, useSession, useToolResult } from "aai-ui";
import { useEffect, useMemo, useRef } from "react";
import type { DispatchState, Incident, Severity } from "./_shared.ts";

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

const alertColors: Record<string, string> = {
  green: "#22c55e",
  yellow: "#eab308",
  orange: "#f97316",
  red: "#ef4444",
};

const severityColors: Record<string, string> = {
  critical: "#ef4444",
  urgent: "#f97316",
  moderate: "#eab308",
  minor: "#22c55e",
};

const statusColors: Record<string, string> = {
  incoming: "#818cf8",
  triaged: "#a78bfa",
  dispatched: "#f59e0b",
  en_route: "#3b82f6",
  on_scene: "#22c55e",
  resolved: "#6b7280",
  escalated: "#ef4444",
};

// Track dashboard state from tool results
interface DashboardState {
  alertLevel: string;
  incidents: Record<
    string,
    { id: string; severity?: Severity; status?: string; location?: string }
  >;
}

function stateColor(state: string): string {
  return state === "listening"
    ? "#22c55e"
    : state === "thinking"
      ? "#eab308"
      : state === "speaking"
        ? "#3b82f6"
        : state === "ready"
          ? "#22c55e"
          : "#6b7280";
}

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

function App() {
  const session = useSession();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const dashRef = useRef<DashboardState>({ alertLevel: "green", incidents: {} });

  // Track incidents and alert level from tool results
  useToolResult("incident_create", (result: unknown) => {
    const r = result as { incident?: Incident };
    if (r.incident) {
      dashRef.current.incidents[r.incident.id] = {
        id: r.incident.id,
        severity: r.incident.severity,
        status: r.incident.status,
        location: r.incident.location,
      };
    }
  });

  useToolResult("incident_triage", (result: unknown) => {
    const r = result as { incident?: Incident };
    if (r.incident) {
      dashRef.current.incidents[r.incident.id] = {
        ...dashRef.current.incidents[r.incident.id],
        id: r.incident.id,
        severity: r.incident.severity,
        status: r.incident.status,
      };
    }
  });

  useToolResult("incident_update_status", (result: unknown) => {
    const r = result as { incident?: Incident };
    if (r.incident) {
      dashRef.current.incidents[r.incident.id] = {
        ...dashRef.current.incidents[r.incident.id],
        id: r.incident.id,
        status: r.incident.status,
      };
    }
  });

  useToolResult("ops_dashboard", (result: unknown) => {
    const r = result as { state?: DispatchState };
    if (r.state) {
      dashRef.current.alertLevel = r.state.alertLevel;
      for (const inc of Object.values(r.state.incidents)) {
        dashRef.current.incidents[inc.id] = {
          id: inc.id,
          severity: inc.severity,
          status: inc.status,
          location: inc.location,
        };
      }
    }
  });

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [session.messages.length]);

  const incidentList = useMemo(
    () => Object.values(dashRef.current.incidents).reverse(),
    [session.toolCalls],
  );
  const activeIncidents = incidentList.filter((i) => i.status !== "resolved");
  const resolvedCount = incidentList.filter((i) => i.status === "resolved").length;

  const alertLevel = dashRef.current.alertLevel;
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
            <span
              className="w-2.5 h-2.5 rounded-full inline-block"
              style={{
                background: stateColor(session.state),
                animation:
                  session.state === "listening"
                    ? "dc-pulse 1.5s ease-in-out infinite"
                    : session.state === "thinking"
                      ? "dc-pulse 0.8s ease-in-out infinite"
                      : "none",
              }}
              title={session.state}
            />
            <span className="text-[11px] font-normal normal-case" style={{ color: "#64748b" }}>
              {session.state === "listening"
                ? "LISTENING"
                : session.state === "thinking"
                  ? "PROCESSING"
                  : session.state === "speaking"
                    ? "TRANSMITTING"
                    : session.state.toUpperCase()}
            </span>
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
            <div className="dc-messages flex-1 overflow-y-auto p-4 flex flex-col gap-2">
              {session.messages.length === 0 && (
                <div className="text-center p-10 text-[13px]" style={{ color: "#475569" }}>
                  Dispatch Command Center standing by. Click START to begin operations.
                </div>
              )}
              {session.messages.map((m: ChatMessage, i: number) => (
                <div
                  key={i}
                  className="rounded-lg text-[13px] max-w-[85%] px-3.5 py-2.5"
                  style={{
                    lineHeight: 1.6,
                    alignSelf: m.role === "assistant" ? "flex-start" : "flex-end",
                    background: m.role === "assistant" ? "#1e293b" : "#172554",
                    animation: "dc-slide-in 0.2s ease-out",
                    borderLeft: m.role === "assistant" ? "3px solid #3b82f6" : "none",
                    borderRight: m.role !== "assistant" ? "3px solid #22d3ee" : "none",
                  }}
                >
                  <div
                    className="text-[10px] uppercase tracking-wider mb-1"
                    style={{ color: "#64748b" }}
                  >
                    {m.role === "assistant" ? "DISPATCH" : "OPERATOR"}
                  </div>
                  {m.content}
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            {session.userTranscript !== null && (
              <div
                className="flex items-center px-4 py-2 text-xs italic min-h-8"
                style={{ background: "#111827", borderTop: "1px solid #1e293b", color: "#64748b" }}
              >
                <span
                  className="w-2.5 h-2.5 rounded-full inline-block mr-2"
                  style={{ background: "#22c55e", animation: "dc-pulse 1.5s ease-in-out infinite" }}
                />
                {session.userTranscript || "..."}
              </div>
            )}
            {session.error && (
              <div
                className="px-4 py-2 text-xs"
                style={{ background: "#450a0a", color: "#fca5a5", borderTop: "1px solid #991b1b" }}
              >
                ERROR: {session.error.message} ({session.error.code})
              </div>
            )}

            <div
              className="flex items-center gap-2.5 px-4 py-3"
              style={{ background: "#111827", borderTop: "1px solid #1e293b" }}
            >
              {!session.started ? (
                <button
                  type="button"
                  className="px-4 py-2 border-none rounded-md font-mono text-xs font-semibold uppercase tracking-wider cursor-pointer text-white"
                  style={{ background: "#2563eb" }}
                  onClick={() => session.start()}
                >
                  Start Dispatch
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="px-4 py-2 border-none rounded-md font-mono text-xs font-semibold uppercase tracking-wider cursor-pointer"
                    style={{
                      background: session.running ? "#334155" : "#2563eb",
                      color: session.running ? "#e2e8f0" : "white",
                    }}
                    onClick={() => session.toggle()}
                  >
                    {session.running ? "Pause" : "Resume"}
                  </button>
                  <button
                    type="button"
                    className="px-4 py-2 border-none rounded-md font-mono text-xs font-semibold uppercase tracking-wider cursor-pointer text-white"
                    style={{ background: "#dc2626" }}
                    onClick={() => session.reset()}
                  >
                    Reset
                  </button>
                </>
              )}
              <div className="flex-1" />
              <span className="text-[10px]" style={{ color: "#475569" }}>
                {incidentList.length} incident{incidentList.length !== 1 ? "s" : ""} logged
              </span>
            </div>
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
                activeIncidents.map((inc) => (
                  <div
                    key={inc.id}
                    className="rounded-md p-2.5 mb-2"
                    style={{
                      background: "#0f172a",
                      animation: "dc-slide-in 0.3s ease-out",
                      border: `1px solid ${severityColors[inc.severity ?? ""] || "#334155"}40`,
                      borderLeft: `3px solid ${severityColors[inc.severity ?? ""] || "#334155"}`,
                    }}
                  >
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-xs font-bold" style={{ color: "#f1f5f9" }}>
                        {inc.id}
                      </span>
                      {inc.severity && (
                        <span
                          className="text-[9px] px-1.5 py-0.5 rounded font-bold uppercase"
                          style={{
                            background: `${severityColors[inc.severity ?? ""]}30`,
                            color: severityColors[inc.severity ?? ""],
                          }}
                        >
                          {inc.severity}
                        </span>
                      )}
                    </div>
                    {inc.location && (
                      <div className="text-[11px] mb-0.5" style={{ color: "#94a3b8" }}>
                        {inc.location}
                      </div>
                    )}
                    {inc.status && (
                      <div
                        className="text-[10px] uppercase tracking-wider"
                        style={{ color: statusColors[inc.status] || "#6b7280" }}
                      >
                        {inc.status.replace("_", " ")}
                      </div>
                    )}
                  </div>
                ))
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

client({
  component: App,
  theme: {
    bg: "#0a0a0f",
    primary: "#3b82f6",
    text: "#e2e8f0",
    surface: "#1a1a2e",
    border: "#1e293b",
  },
});
