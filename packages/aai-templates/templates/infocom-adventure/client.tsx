/** @jsxImportSource react */

import type { ChatMessage } from "@alexkroman1/aai-ui";
import { client, useSession } from "@alexkroman1/aai-ui";
import { useEffect, useRef } from "react";

const CSS = `
@keyframes ic-flicker {
  0% { opacity: 0.97; } 5% { opacity: 0.95; } 10% { opacity: 0.98; }
  15% { opacity: 0.96; } 20% { opacity: 0.99; } 50% { opacity: 0.96; }
  80% { opacity: 0.98; } 100% { opacity: 0.97; }
}
@keyframes ic-scanline {
  0% { transform: translateY(-100%); }
  100% { transform: translateY(100vh); }
}
@keyframes ic-boot {
  0% { opacity: 0; transform: scaleY(0.01); }
  30% { opacity: 1; transform: scaleY(0.01); }
  60% { transform: scaleY(1); }
  100% { transform: scaleY(1); opacity: 1; }
}
@keyframes ic-pulse {
  0%, 100% { box-shadow: 0 0 8px rgba(0, 255, 65, 0.3); }
  50% { box-shadow: 0 0 20px rgba(0, 255, 65, 0.6); }
}
.ic-crt::before {
  content: ""; position: absolute; inset: 0; pointer-events: none; z-index: 10;
  background: repeating-linear-gradient(0deg, rgba(0,0,0,0.15) 0px, rgba(0,0,0,0.15) 1px, transparent 1px, transparent 3px);
}
.ic-crt::after {
  content: ""; position: absolute; top: 0; left: 0; right: 0; height: 4px;
  background: rgba(0,255,65,0.08); animation: ic-scanline 8s linear infinite;
  pointer-events: none; z-index: 11;
}
.ic-messages::-webkit-scrollbar { width: 6px; }
.ic-messages::-webkit-scrollbar-track { background: #001a00; }
.ic-messages::-webkit-scrollbar-thumb { background: #00ff41; }
.ic-user-msg::before { content: "> "; color: #00ccff; }
.ic-transcript::before { content: "> "; color: #007a1e; }
`;

const ASCII_LOGO = `
 ____  ___  ____  _  __
/__  |/ _ \\|  _ \\| |/ /
  / /| | | | |_) | ' /
 / / | |_| |  _ <| . \\
/_/   \\___/|_| \\_\\_|\\_\\
`;

const CRT_BG = "#000800";
const GREEN = "#00ff41";
const GREEN_DIM = "#00aa2a";
const GREEN_DARK = "#003300";
const CYAN = "#00ccff";

function InfocomAdventure() {
  const session = useSession();
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  const stateLabel =
    session.state === "listening"
      ? "Listening"
      : session.state === "speaking"
        ? "Narrating"
        : session.state === "thinking"
          ? "Thinking"
          : session.state === "connecting"
            ? "Connecting"
            : session.state === "ready"
              ? "Ready"
              : "Idle";

  const msgCount = session.messages.filter((m: ChatMessage) => m.role === "user").length;

  const dotColor =
    session.state === "listening"
      ? GREEN
      : session.state === "speaking"
        ? "#ffaa00"
        : session.state === "thinking"
          ? CYAN
          : GREEN_DARK;

  if (!session.started) {
    return (
      <>
        <style>{CSS}</style>
        <div
          className="ic-crt fixed inset-0 overflow-hidden"
          style={{
            background: CRT_BG,
            color: GREEN,
            fontFamily: "monospace",
            fontSize: "15px",
            lineHeight: 1.6,
            animation: "ic-flicker 4s infinite",
          }}
        >
          <div
            className="flex flex-col items-center justify-center h-full text-center p-10"
            style={{ animation: "ic-boot 1.5s ease-out" }}
          >
            <div
              className="text-[11px] whitespace-pre mb-8"
              style={{ textShadow: "0 0 10px rgba(0,255,65,0.5)" }}
            >
              {ASCII_LOGO}
            </div>
            <div className="text-[13px] mb-2" style={{ color: GREEN_DIM }}>
              INFOCOM INTERACTIVE FICTION
            </div>
            <div className="text-[13px] mb-2" style={{ color: GREEN_DIM }}>
              Copyright (c) 1980 Infocom, Inc.
            </div>
            <div className="text-[13px] mb-2" style={{ color: GREEN_DIM }}>
              All rights reserved.
            </div>
            <div className="text-[13px] mt-4" style={{ color: GREEN }}>
              VOICE-ENABLED EDITION
            </div>
            <div className="text-[13px] mt-6" style={{ color: GREEN_DIM }}>
              Release 88 / Serial No. 840726
            </div>
            <button
              type="button"
              className="mt-10 px-12 py-3.5 bg-transparent cursor-pointer uppercase tracking-[3px] font-mono text-base"
              style={{
                color: GREEN,
                border: `1px solid ${GREEN}`,
                animation: "ic-pulse 2s ease-in-out infinite",
              }}
              onClick={session.start}
            >
              Begin Adventure
            </button>
          </div>
          <div
            className="fixed inset-0 pointer-events-none z-12"
            style={{
              background:
                "radial-gradient(ellipse at center, transparent 60%, rgba(0,0,0,0.4) 100%)",
            }}
          />
        </div>
      </>
    );
  }

  return (
    <>
      <style>{CSS}</style>
      <div
        className="ic-crt fixed inset-0 overflow-hidden"
        style={{
          background: CRT_BG,
          color: GREEN,
          fontFamily: "monospace",
          fontSize: "15px",
          lineHeight: 1.6,
          animation: "ic-flicker 4s infinite",
        }}
      >
        <div className="flex flex-col h-full">
          {/* Status bar */}
          <div
            className="flex items-center justify-between px-5 py-2 text-[13px] font-bold tracking-wider shrink-0"
            style={{ background: GREEN, color: CRT_BG }}
          >
            <div className="flex gap-6">
              <span>ZORK I</span>
              <span>Moves: {msgCount}</span>
            </div>
            <span>Voice Adventure</span>
          </div>

          {session.error && (
            <div className="px-5 py-2 text-xs" style={{ background: "#3a0000", color: "#ff4141" }}>
              ERROR: {session.error.message}
            </div>
          )}

          {/* Messages */}
          <div
            className="ic-messages flex-1 overflow-y-auto p-5"
            style={{ scrollbarWidth: "thin", scrollbarColor: `${GREEN} #001a00` }}
          >
            {session.messages.map((msg: ChatMessage, i: number) => (
              <div
                key={i}
                className={`mb-4 ${msg.role === "user" ? "ic-user-msg" : ""}`}
                style={{
                  textShadow:
                    msg.role === "user"
                      ? "0 0 5px rgba(0,204,255,0.3)"
                      : "0 0 5px rgba(0,255,65,0.3)",
                  color: msg.role === "user" ? CYAN : GREEN,
                }}
              >
                {msg.content}
              </div>
            ))}
            {session.userTranscript !== null && (
              <div
                className="ic-transcript italic"
                style={{ color: "#007a1e", textShadow: "0 0 5px rgba(0,255,65,0.15)" }}
              >
                {session.userTranscript || "..."}
              </div>
            )}
            <div ref={bottom} />
          </div>

          {/* Footer controls */}
          <div
            className="flex items-center justify-between px-5 py-2 shrink-0 gap-3"
            style={{ borderTop: `1px solid ${GREEN_DARK}`, background: "#001100" }}
          >
            <div
              className="flex items-center gap-2.5 text-xs uppercase tracking-wider"
              style={{ color: GREEN_DIM }}
            >
              <div
                className="w-2 h-2 rounded-full"
                style={{
                  background: dotColor,
                  boxShadow: dotColor !== GREEN_DARK ? `0 0 6px ${dotColor}` : "none",
                }}
              />
              <span>{stateLabel}</span>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className="px-4 py-1 bg-transparent cursor-pointer uppercase tracking-wider font-mono text-[11px]"
                style={{ color: GREEN_DIM, border: `1px solid ${GREEN_DARK}` }}
                onClick={session.toggle}
              >
                {session.running ? "[P]ause" : "[R]esume"}
              </button>
              <button
                type="button"
                className="px-4 py-1 bg-transparent cursor-pointer uppercase tracking-wider font-mono text-[11px]"
                style={{ color: GREEN_DIM, border: `1px solid ${GREEN_DARK}` }}
                onClick={session.reset}
              >
                [Q]uit
              </button>
            </div>
          </div>
        </div>
        <div
          className="fixed inset-0 pointer-events-none z-12"
          style={{
            background: "radial-gradient(ellipse at center, transparent 60%, rgba(0,0,0,0.4) 100%)",
          }}
        />
      </div>
    </>
  );
}

client({
  component: InfocomAdventure,
  theme: {
    bg: CRT_BG,
    primary: GREEN,
    text: GREEN,
    surface: "#001a00",
    border: GREEN_DARK,
  },
});
