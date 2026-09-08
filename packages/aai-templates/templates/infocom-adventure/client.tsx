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
import { gameStatus } from "./shared.ts";

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

// The cursor dot's colour per session state, as an EXHAUSTIVE map rather than an
// if-chain with a grey default.
//
// The palette is this template's own — every client here paints the same six
// states in its own colours, so it is the one prop `<SessionStateDot>` cannot
// default. What the SDK does own is `AgentState`, and `satisfies
// Record<AgentState, string>` is what borrows it: a state added there stops
// compiling here, where the `state === "…"` chain this replaced answered a new
// state with a silent grey badge in three separate files and no way to notice.
const STATE_COLORS = {
  disconnected: GREEN_DARK,
  connecting: GREEN_DARK,
  ready: GREEN_DARK,
  listening: GREEN,
  thinking: CYAN,
  speaking: "#ffaa00",
  error: GREEN_DARK,
} satisfies Record<AgentState, string>;

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
 * The exchange, in the CRT idiom.
 *
 * `<ConversationView>` rather than `session.messages`: the four decisions
 * `<MessageList>` makes — the message/tool-call interleave, the streaming
 * narrator line, the transcript's `null`-vs-`""` distinction and the thinking
 * rule — are the view's now, so this fills its slots instead of shipping a
 * conversation missing all four. The old list read `messages` alone, so the
 * eight `game_state_*` calls and every partial of the narrator's reply were
 * invisible: the screen sat still until a whole utterance finalized.
 *
 * It also subscribes per FIELD, so a partial transcript no longer re-renders
 * the status bar, the footer and the CRT overlays with it.
 */
function Transcript() {
  // The one theme read left in this file, and the case `useTheme()` is still
  // for: the scrollbar takes TWO colours and no utility class carries two, so
  // they travel as the custom properties `.aai-scroll` reads — and reading them
  // off the theme beats re-pinning the two hex codes the `mountClient({ theme })`
  // block below already declares.
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
      // printed it in. Dim, because it is beneath the narration and not instead
      // of it — so not the SDK's tool row, which is a chip.
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
      // The blinking block is the only sign the parser is working, and to a
      // screen reader it is one unpronounceable glyph — hence the label.
      thinkingLabel="The parser is thinking"
      thinkingClassName="animate-pulse text-[#00aa2a]"
      thinkingIndicator={<>&#9612;</>}
    />
  );
}

/**
 * The status line the printed games put across the top of the screen: the room
 * you are in on the left, the score and the turn count on the right.
 *
 * Every number here is the GAME's, arriving through `syncState` — the projection
 * `shared.ts` declares and `agent.ts` sends. What stood here counted the turns
 * in the browser, by reducing over the message list for `role === "user"`, and
 * that count is a different quantity from the `moves` the narrator is told: the
 * transcript hook counts a committed utterance, while the message list also
 * moves on a resumed session and on turns the runtime merges. The room and the
 * score it could not show at all.
 */
function StatusBar() {
  const { currentRoom, score, rank, moves } = useAgentState(gameStatus);
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

/*
 * The narrator's one word for each state. Only `speaking` gets a CRT word; the
 * rest are `<SessionStateDot>`'s defaults, so a state added upstream reads as
 * something rather than falling through to whichever arm a ternary chain ended
 * on — which is what the chain this replaced did, answering every unlisted
 * state with "Idle".
 */
const STATE_LABELS: Partial<Record<AgentState, string>> = {
  speaking: "Narrating",
};

/**
 * The live state dot and its label, on its own subscription. A CRT dot GLOWS
 * rather than beats, so `pulse` is off and the glow is a `currentColor` shadow
 * — the dot writes its colour to `color` for exactly this. On the dark states
 * the glow is the same near-black as the ground and reads as none.
 */
function StatusDot() {
  return (
    <SessionStateDot
      colors={STATE_COLORS}
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

/*
 * Pause/resume, new game and hang-up.
 *
 * `<SessionControls>` is the row `<Controls>` never had — Start, Pause/Resume,
 * New Conversation, End — and here that is a new GAME: its `restart` is `end()`
 * then `start()`, so the session-scoped game state starts over and the player
 * is dealt straight into it, and its `end` alone flips `started` back so the
 * title screen returns. The Start branch never renders here because this
 * footer only exists once the title screen's own button has dialled.
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

/** The CRT itself: the flicker, the scanlines and the vignette every screen
 *  sits inside. */
function Crt({ children }: { children: ReactNode }) {
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
        {children}
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

        {/* The SDK's announced banner, not a CRT-coloured copy: once `session-core`
            latches a fatal error the state eyebrow goes back to reading like a
            live session, so this is the only remaining signal — and the two
            sibling chromes had already drifted on whether to print the code.
            The frame's own square corners, the way `dispatch-center` and
            `retail` take it. */}
        <SessionErrorBanner className="rounded-none border-x-0 border-b-0 font-mono" />
        <Transcript />
        <Footer />
      </div>
    </Crt>
  );
}

mountClient({
  component: InfocomAdventure,
  theme: {
    bg: CRT_BG,
    primary: GREEN,
    text: GREEN,
    surface: "#001a00",
    border: GREEN_DARK,
  },
});
