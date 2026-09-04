import "@alexkroman1/aai-ui/styles.css";
import type { AgentState } from "@alexkroman1/aai-ui";
import {
  AutoScroll,
  client,
  useConversation,
  useSessionActions,
  useSessionError,
  useSessionSelector,
  useTheme,
} from "@alexkroman1/aai-ui";
import type { ReactNode } from "react";

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
// states in its own colours, so the SDK has nothing to share but the union. What
// the SDK does own is `AgentState`, and `satisfies Record<AgentState, string>`
// is what borrows it: a state added there stops compiling here, where the
// `state === "…"` chain this replaced answered a new state with a silent grey
// badge in three separate files and no way to notice.
const STATE_COLORS = {
  disconnected: GREEN_DARK,
  connecting: GREEN_DARK,
  ready: GREEN_DARK,
  listening: GREEN,
  thinking: CYAN,
  speaking: "#ffaa00",
  error: GREEN_DARK,
} satisfies Record<AgentState, string>;

/**
 * The exchange, in the CRT idiom.
 *
 * `useConversation()` rather than `session.messages`: the four decisions
 * `<MessageList>` makes — the message/tool-call interleave, the streaming
 * narrator line, the transcript's `null`-vs-`""` distinction and the thinking
 * rule — are the hook's now, so this renders them instead of shipping a
 * conversation missing all four. The old list read `messages` alone, so the
 * eight `game_state_*` calls and every partial of the narrator's reply were
 * invisible: the screen sat still until a whole utterance finalized.
 *
 * It also subscribes per FIELD, so a partial transcript no longer re-renders
 * the status bar, the footer and the CRT overlays with it.
 */
function Transcript() {
  const { items, streaming, transcript, thinking } = useConversation();
  // The one theme read left in this file, and the case `useTheme()` is still
  // for: `scrollbar-color` takes TWO values and has no utility class, so it has
  // to be a style — and reading it off the theme beats re-pinning the two hex
  // codes the `client({ theme })` block below already declares.
  const theme = useTheme();

  return (
    <AutoScroll
      scrollClassName="ic-messages overflow-y-auto"
      contentClassName="p-5"
      style={{ scrollbarWidth: "thin", scrollbarColor: `${theme.primary} ${theme.surface}` }}
    >
      {items.map((item) =>
        item.kind === "message" ? (
          <div
            key={item.message.id}
            className={`mb-4 ${item.message.role === "user" ? "ic-user-msg" : ""}`}
            style={{
              textShadow:
                item.message.role === "user"
                  ? "0 0 5px rgba(0,204,255,0.3)"
                  : "0 0 5px rgba(0,255,65,0.3)",
              color: item.message.role === "user" ? CYAN : GREEN,
            }}
          >
            {item.message.content}
          </div>
        ) : (
          // The game engine's own bookkeeping, in the idiom the machine would
          // have printed it in. Dim, because it is beneath the narration and
          // not instead of it.
          <div key={item.toolCall.callId} className="mb-4 text-[13px]" style={{ color: GREEN_DIM }}>
            {`[ ${item.toolCall.name.replace(/^game_state_/, "").replace(/_/g, " ")}${
              item.toolCall.status === "pending" ? " …" : ""
            } ]`}
          </div>
        ),
      )}
      {streaming !== null && (
        <div className="mb-4" style={{ color: GREEN, textShadow: "0 0 5px rgba(0,255,65,0.3)" }}>
          {streaming}
        </div>
      )}
      {transcript.speaking && (
        <div
          className="ic-transcript italic"
          style={{ color: "#007a1e", textShadow: "0 0 5px rgba(0,255,65,0.15)" }}
        >
          {transcript.text}
        </div>
      )}
      {/* Same contract as the shipped `MessageList`'s indicator: the blinking
          block is the only sign the parser is working, and to a screen reader it
          is one unpronounceable glyph. */}
      {thinking && (
        <div
          role="status"
          aria-label="The parser is thinking"
          className="animate-pulse"
          style={{ color: GREEN_DIM }}
        >
          &#9612;
        </div>
      )}
    </AutoScroll>
  );
}

/** Module scope, so the selector has a STABLE identity: an inline arrow makes
 *  `useSyncExternalStoreWithSelector` rebuild its selection memo every render,
 *  and this runs on every snapshot push — each STT partial and streaming
 *  delta. Counting with `reduce` rather than `filter().length` for the same
 *  reason: the array copy is thrown away, and it grows for the whole adventure. */
const userTurns = (snapshot: { messages: { role: string }[] }): number =>
  snapshot.messages.reduce((n, message) => (message.role === "user" ? n + 1 : n), 0);

/** The turn counter — a NUMBER out of the selector, so a new message array with
 *  the same user-message count re-renders nothing. */
function TurnCount() {
  const turns = useSessionSelector(userTurns);
  return <span>Turns: {turns}</span>;
}

/** The live state dot and its label. */
function StatusDot() {
  const state = useSessionSelector((snapshot) => snapshot.state);
  const dotColor = STATE_COLORS[state];
  const stateLabel =
    state === "listening"
      ? "Listening"
      : state === "speaking"
        ? "Narrating"
        : state === "thinking"
          ? "Thinking"
          : state === "connecting"
            ? "Connecting"
            : state === "ready"
              ? "Ready"
              : "Idle";

  return (
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
  );
}

/**
 * The fault line.
 *
 * `role="alert"` for the reason `ConsoleShell` gives: once `session-core`
 * latches a fatal error the state eyebrow goes back to reading like a live
 * session, so this banner is the only remaining signal — and a screen reader is
 * never told an unannounced one appeared.
 */
function ErrorBanner() {
  const error = useSessionError();
  if (!error) return null;
  return (
    <div
      role="alert"
      className="px-5 py-2 text-xs"
      style={{ background: "#3a0000", color: "#ff4141" }}
    >
      ERROR: {error.message} ({error.code})
    </div>
  );
}

/*
 * Pause/resume, new game and hang-up.
 *
 * `useSessionActions()` is the narrow way `<Controls>` reaches the methods, and
 * it is published now — so this row takes the three it presses and one
 * selector for the flag it reads, instead of a whole-snapshot `useSession()`
 * that re-rendered the footer on every partial transcript.
 */
function Footer() {
  const { toggle, restart, end } = useSessionActions();
  const running = useSessionSelector((snapshot) => snapshot.running);
  return (
    <div
      className="flex items-center justify-between px-5 py-2 shrink-0 gap-3"
      style={{ borderTop: `1px solid ${GREEN_DARK}`, background: "#001100" }}
    >
      <StatusDot />
      <div className="flex gap-2">
        <button
          type="button"
          className="px-4 py-1 bg-transparent cursor-pointer uppercase tracking-wider font-mono text-[11px]"
          style={{ color: GREEN_DIM, border: `1px solid ${GREEN_DARK}` }}
          onClick={toggle}
        >
          {running ? "[P]ause" : "[R]esume"}
        </button>
        {/* The one-click new conversation the default shell's `<Controls>`
            gives every other template — a custom `component:` renders no
            `<Controls>`, so this screen has to say it itself. Here that is a
            new game: end() drops the sessionId, so the session-scoped game
            state starts over, and start() deals the player straight into it. */}
        <button
          type="button"
          className="px-4 py-1 bg-transparent cursor-pointer uppercase tracking-wider font-mono text-[11px]"
          style={{ color: GREEN_DIM, border: `1px solid ${GREEN_DARK}` }}
          onClick={restart}
        >
          [N]ew Game
        </button>
        {/* The hang-up: end() alone flips `started` back, so the title screen
            returns and nothing is dialled until the player asks for it. */}
        <button
          type="button"
          className="px-4 py-1 bg-transparent cursor-pointer uppercase tracking-wider font-mono text-[11px]"
          style={{ color: GREEN_DIM, border: `1px solid ${GREEN_DARK}` }}
          onClick={() => end()}
        >
          [Q]uit
        </button>
      </div>
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
        {/* Status bar */}
        <div
          className="flex items-center justify-between px-5 py-2 text-[13px] font-bold tracking-wider shrink-0"
          style={{ background: GREEN, color: CRT_BG }}
        >
          <div className="flex gap-6">
            <span>CAVERN ADVENTURE</span>
            <TurnCount />
          </div>
          <span>Voice Adventure</span>
        </div>

        <ErrorBanner />
        <Transcript />
        <Footer />
      </div>
    </Crt>
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
