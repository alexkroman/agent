import "@alexkroman1/aai-ui/styles.css";
import type { AgentState, ChatMessage, SessionControlButton } from "@alexkroman1/aai-ui";
import {
  ConversationView,
  mountClient,
  SessionControls,
  SessionErrorBanner,
  SessionStateDot,
  useAgentState,
  useSessionActions,
  useSessionSelector,
  useTheme,
} from "@alexkroman1/aai-ui";
import type { CSSProperties, ReactNode } from "react";
import { gameSlot } from "./shared.ts";

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
.ic-user-msg::before { content: "> "; color: #00ccff; }
.ic-transcript::before { content: "> "; color: #007a1e; }
`;

const ASCII_LOGO = `
  ____    _    __     __ _____  ____   _   _
 / ___|  / \\   \\ \\   / /| ____||  _ \\ | \\ | |
| |     / _ \\   \\ \\ / / |  _|  | |_) ||  \\| |
| |___ / ___ \\   \\ V /  | |___ |  _ < | |\\  |
 \\____/_/   \\_\\   \\_/   |_____||_| \\_\\|_| \\_|
`;

const CRT_BG = "#000800";
const GREEN = "#00ff41";
const GREEN_DIM = "#00aa2a";
const GREEN_DARK = "#003300";
const CYAN = "#00ccff";

/** One line of the exchange, in the CRT's two inks. */
function Line({ role, content }: ChatMessage) {
  return (
    <div
      className={`mb-4 ${role === "user" ? "ic-user-msg" : ""}`}
      style={{
        textShadow: role === "user" ? "0 0 5px rgba(0,204,255,0.3)" : "0 0 5px rgba(0,255,65,0.3)",
        color: role === "user" ? CYAN : GREEN,
      }}
    >
      {content}
    </div>
  );
}

/**
 * The exchange, in the CRT idiom. `<ConversationView>` owns the interleave,
 * the streaming narrator line and the thinking rule; this fills its slots.
 */
function Transcript() {
  // The scrollbar takes two colours and no utility class carries two, so they
  // travel as the custom properties `.aai-scroll` reads.
  const theme = useTheme();
  const scrollbar = {
    "--aai-scrollbar-thumb": theme.primary,
    "--aai-scrollbar-track": theme.surface,
  } as CSSProperties;

  return (
    <ConversationView
      scrollClassName="aai-scroll overflow-y-auto"
      contentClassName="p-5"
      style={scrollbar}
      renderMessage={(message) => <Line {...message} />}
      // The game engine's own bookkeeping, in the idiom the machine would have
      // printed it in: dim, beneath the narration rather than a chip.
      renderTool={(toolCall) => (
        <div className="mb-4 text-[13px]" style={{ color: GREEN_DIM }}>
          {`[ ${toolCall.name.replace(/^game_state_/, "").replace(/_/g, " ")}${
            toolCall.status === "pending" ? " …" : ""
          } ]`}
        </div>
      )}
      renderTranscript={({ text }) => (
        <div
          className="ic-transcript italic"
          style={{ color: "#007a1e", textShadow: "0 0 5px rgba(0,255,65,0.15)" }}
        >
          {text}
        </div>
      )}
      // The blinking block is one unpronounceable glyph to a screen reader.
      thinkingLabel="The parser is thinking"
      thinkingClassName="animate-pulse text-[#00aa2a]"
      thinkingIndicator={<>&#9612;</>}
    />
  );
}

/**
 * The status line the printed games put across the top of the screen: the room
 * on the left, the score and the turn count on the right — every number the
 * game's own, through the slot's synced view.
 */
function StatusBar() {
  const { currentRoom, score, rank, moves } = useAgentState(gameSlot.projected);
  return (
    <div
      className="flex items-center justify-between px-5 py-2 text-[13px] font-bold tracking-wider shrink-0"
      style={{ background: GREEN, color: CRT_BG }}
    >
      <span>{currentRoom}</span>
      <div className="flex gap-6">
        <span>
          Score: {score} ({rank})
        </span>
        <span>Moves: {moves}</span>
      </div>
    </div>
  );
}

/** Only `speaking` gets a CRT word; the rest are the dot's own defaults. */
const STATE_LABELS: Partial<Record<AgentState, string>> = {
  speaking: "Narrating",
};

/**
 * The live state dot and its label. A CRT dot GLOWS rather than beats, so
 * `pulse` is off and the glow is a `currentColor` shadow. The theme gives the
 * dot its green; only the three states a CRT paints differently are named.
 */
function StatusDot() {
  return (
    <SessionStateDot
      colors={{ ready: GREEN_DARK, thinking: CYAN, speaking: "#ffaa00" }}
      labels={STATE_LABELS}
      pulse={false}
      className="gap-2.5 text-xs uppercase tracking-wider text-[#00aa2a]"
      dotClassName="w-2 h-2 shadow-[0_0_6px_currentColor]"
    />
  );
}

const CRT_BUTTON =
  "px-4 py-1 bg-transparent cursor-pointer uppercase tracking-wider font-mono text-[11px]";

/** Every footer key looks the same on a CRT; only the word differs. */
function crtButton({ label, onClick }: SessionControlButton) {
  return (
    <button
      type="button"
      className={CRT_BUTTON}
      style={{ color: GREEN_DIM, border: `1px solid ${GREEN_DARK}` }}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/**
 * Pause/resume, new game and hang-up. `<SessionControls>`' restart is `end()`
 * then `start()`, so the session-scoped game starts over and the player is
 * dealt straight into it; its `end` alone brings the title screen back.
 */
function Footer() {
  return (
    <div
      className="flex items-center justify-between px-5 py-2 shrink-0 gap-3"
      style={{ borderTop: `1px solid ${GREEN_DARK}`, background: "#001100" }}
    >
      <StatusDot />
      <SessionControls
        labels={{ pause: "[P]ause", resume: "[R]esume", restart: "[N]ew Game", end: "[Q]uit" }}
        renderButton={crtButton}
      />
    </div>
  );
}

/** The CRT itself: the flicker, the scanlines and the vignette every screen sits inside. */
function Crt({ children }: { children: ReactNode }) {
  return (
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
      {children}
      <div
        className="fixed inset-0 pointer-events-none z-12"
        style={{
          background: "radial-gradient(ellipse at center, transparent 60%, rgba(0,0,0,0.4) 100%)",
        }}
      />
    </div>
  );
}

function TitleScreen() {
  const { start } = useSessionActions();
  return (
    <Crt>
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
          AN INTERACTIVE FICTION
        </div>
        <div className="text-[13px] mb-2" style={{ color: GREEN_DIM }}>
          In the style of the classic text adventures.
        </div>
        <div className="text-[13px] mt-4" style={{ color: GREEN }}>
          VOICE-ENABLED EDITION
        </div>
        <button
          type="button"
          className="mt-10 px-12 py-3.5 bg-transparent cursor-pointer uppercase tracking-[3px] font-mono text-base"
          style={{
            color: GREEN,
            border: `1px solid ${GREEN}`,
            animation: "ic-pulse 2s ease-in-out infinite",
          }}
          onClick={start}
        >
          Begin Adventure
        </button>
      </div>
    </Crt>
  );
}

function InfocomAdventure() {
  const started = useSessionSelector((snapshot) => snapshot.started);
  if (!started) return <TitleScreen />;

  return (
    <Crt>
      <div className="flex flex-col h-full">
        <StatusBar />
        {/* The SDK's announced banner: once a fatal error latches, the state
            eyebrow reads like a live session again, so this is the one signal. */}
        <SessionErrorBanner className="rounded-none border-x-0 border-b-0 font-mono" />
        <Transcript />
        <Footer />
      </div>
    </Crt>
  );
}

mountClient({
  component: InfocomAdventure,
  // A CRT is its own palette, so the five tokens rather than a light/dark preset.
  theme: {
    bg: CRT_BG,
    primary: GREEN,
    text: GREEN,
    surface: "#001a00",
    border: GREEN_DARK,
  },
  css: CSS,
});
