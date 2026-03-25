import "@alexkroman1/aai-ui/styles.css";
import { mount, useSession } from "@alexkroman1/aai-ui";
import type { Message } from "@alexkroman1/aai-ui";
import { useEffect, useRef } from "preact/hooks";

const CSS = `
@keyframes ic-flicker {
  0% { opacity: 0.97; }
  5% { opacity: 0.95; }
  10% { opacity: 0.98; }
  15% { opacity: 0.96; }
  20% { opacity: 0.99; }
  50% { opacity: 0.96; }
  80% { opacity: 0.98; }
  100% { opacity: 0.97; }
}
@keyframes ic-scanline {
  0% { transform: translateY(-100%); }
  100% { transform: translateY(100vh); }
}
@keyframes ic-blink {
  0%, 49% { opacity: 1; }
  50%, 100% { opacity: 0; }
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
  content: "";
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    0deg,
    rgba(0, 0, 0, 0.15) 0px,
    rgba(0, 0, 0, 0.15) 1px,
    transparent 1px,
    transparent 3px
  );
  pointer-events: none;
  z-index: 10;
}
.ic-crt::after {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 4px;
  background: rgba(0, 255, 65, 0.08);
  animation: ic-scanline 8s linear infinite;
  pointer-events: none;
  z-index: 11;
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

function InfocomAdventure() {
  const { session, started, running, start, toggle, reset } = useSession();
  const bottom = useRef<HTMLDivElement>(null);

  const totalMessages = session.messages.value.length;
  const utterance = session.userUtterance.value;
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [totalMessages, utterance]);

  const stateVal = session.state.value;
  const stateLabel = stateVal === "listening"
    ? "Listening"
    : stateVal === "speaking"
    ? "Narrating"
    : stateVal === "thinking"
    ? "Thinking"
    : stateVal === "connecting"
    ? "Connecting"
    : stateVal === "ready"
    ? "Ready"
    : "Idle";

  const msgCount =
    session.messages.value.filter((m: Message) => m.role === "user").length;

  const dotColor = stateVal === "listening"
    ? "#00ff41"
    : stateVal === "speaking"
    ? "#ffaa00"
    : stateVal === "thinking"
    ? "#00ccff"
    : "#003300";

  if (!started.value) {
    return (
      <>
        <style>{CSS}</style>
        <div
          class="ic-crt fixed inset-0 overflow-hidden"
          style={{
            background: "#000800",
            color: "#00ff41",
            fontFamily: "monospace",
            fontSize: "15px",
            lineHeight: 1.6,
            animation: "ic-flicker 4s infinite",
          }}
        >
          <div
            class="flex flex-col items-center justify-center h-full text-center p-10"
            style={{ animation: "ic-boot 1.5s ease-out" }}
          >
            <div
              class="text-[11px] whitespace-pre mb-8"
              style={{ textShadow: "0 0 10px rgba(0, 255, 65, 0.5)" }}
            >
              {ASCII_LOGO}
            </div>
            <div class="text-[13px] mb-2" style={{ color: "#00aa2a" }}>
              INFOCOM INTERACTIVE FICTION
            </div>
            <div class="text-[13px] mb-2" style={{ color: "#00aa2a" }}>
              Copyright (c) 1980 Infocom, Inc.
            </div>
            <div class="text-[13px] mb-2" style={{ color: "#00aa2a" }}>
              All rights reserved.
            </div>
            <div class="text-[13px] mt-4" style={{ color: "#00ff41" }}>
              VOICE-ENABLED EDITION
            </div>
            <div class="text-[13px] mt-6" style={{ color: "#00aa2a" }}>
              Release 88 / Serial No. 840726
            </div>
            <button
              type="button"
              class="mt-10 px-12 py-3.5 bg-transparent cursor-pointer uppercase tracking-[3px] font-mono text-base"
              style={{
                color: "#00ff41",
                border: "1px solid #00ff41",
                animation: "ic-pulse 2s ease-in-out infinite",
              }}
              onClick={start}
            >
              Begin Adventure
            </button>
          </div>
          <div
            class="fixed inset-0 pointer-events-none z-[12]"
            style={{
              background:
                "radial-gradient(ellipse at center, transparent 60%, rgba(0, 0, 0, 0.4) 100%)",
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
        class="ic-crt fixed inset-0 overflow-hidden"
        style={{
          background: "#000800",
          color: "#00ff41",
          fontFamily: "monospace",
          fontSize: "15px",
          lineHeight: 1.6,
          animation: "ic-flicker 4s infinite",
        }}
      >
        <div class="flex flex-col h-full">
          {/* Status bar */}
          <div
            class="flex items-center justify-between px-5 py-2 text-[13px] font-bold tracking-wider shrink-0"
            style={{ background: "#00ff41", color: "#000800" }}
          >
            <div class="flex gap-6">
              <span>ZORK I</span>
              <span>Moves: {msgCount}</span>
            </div>
            <span>Voice Adventure</span>
          </div>

          {session.error.value && (
            <div
              class="px-5 py-2 text-xs"
              style={{ background: "#3a0000", color: "#ff4141" }}
            >
              ERROR: {session.error.value.message}
            </div>
          )}

          {/* Messages */}
          <div
            class="ic-messages flex-1 overflow-y-auto p-5"
            style={{
              scrollbarWidth: "thin",
              scrollbarColor: "#00ff41 #001a00",
            }}
          >
            {session.messages.value.map((msg: Message, i: number) => (
              <div
                key={i}
                class={`mb-4 ${msg.role === "user" ? "ic-user-msg" : ""}`}
                style={{
                  textShadow: msg.role === "user"
                    ? "0 0 5px rgba(0, 204, 255, 0.3)"
                    : "0 0 5px rgba(0, 255, 65, 0.3)",
                  color: msg.role === "user" ? "#00ccff" : "#00ff41",
                }}
              >
                {msg.content}
              </div>
            ))}
            {session.userUtterance.value !== null && (
              <div
                class="ic-transcript italic"
                style={{
                  color: "#007a1e",
                  textShadow: "0 0 5px rgba(0, 255, 65, 0.15)",
                }}
              >
                {session.userUtterance.value || "..."}
              </div>
            )}
            <div ref={bottom} />
          </div>

          {/* Footer controls */}
          <div
            class="flex items-center justify-between px-5 py-2 shrink-0 gap-3"
            style={{
              borderTop: "1px solid #003300",
              background: "#001100",
            }}
          >
            <div
              class="flex items-center gap-2.5 text-xs uppercase tracking-wider"
              style={{ color: "#00aa2a" }}
            >
              <div
                class="w-2 h-2 rounded-full"
                style={{
                  background: dotColor,
                  boxShadow: dotColor !== "#003300"
                    ? `0 0 6px ${dotColor}`
                    : "none",
                }}
              />
              <span>{stateLabel}</span>
            </div>
            <div class="flex gap-2">
              <button
                type="button"
                class="px-4 py-1 bg-transparent cursor-pointer uppercase tracking-wider font-mono text-[11px]"
                style={{ color: "#00aa2a", border: "1px solid #003300" }}
                onClick={toggle}
              >
                {running.value ? "[P]ause" : "[R]esume"}
              </button>
              <button
                type="button"
                class="px-4 py-1 bg-transparent cursor-pointer uppercase tracking-wider font-mono text-[11px]"
                style={{ color: "#00aa2a", border: "1px solid #003300" }}
                onClick={reset}
              >
                [Q]uit
              </button>
            </div>
          </div>
        </div>
        <div
          class="fixed inset-0 pointer-events-none z-[12]"
          style={{
            background:
              "radial-gradient(ellipse at center, transparent 60%, rgba(0, 0, 0, 0.4) 100%)",
          }}
        />
      </div>
    </>
  );
}

mount(InfocomAdventure);
