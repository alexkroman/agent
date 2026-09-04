// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:session` epoch 3.
 *
 * A custom chrome as it was authored at epoch 3 — the shape the three
 * custom-chrome templates shared: a narrowly-subscribed status line, an
 * announced error banner read off the snapshot, a conversation built from
 * `useConversation`, the user's live partial from `useUserTranscript`, the
 * agent's own event log, and one whole-session read for the control row. It
 * must keep compiling for as long as epoch 3 is advertised as supported.
 *
 * Epoch 3 is epoch 2 plus `restart()`, so this file is epoch 2's example with
 * the control row an epoch-3 author would actually write — see
 * {@link Controls}, and `v2.tsx` for why the factory rather than a literal is
 * how a `SessionCore` is obtained here.
 *
 * ## What moved, and why epoch 3 survives it
 *
 * Epoch 4 ADDED five names — `AGENT_STATE_LABELS`, `SessionActions`,
 * `useSessionActions`, `useSessionError` and `useSessionStatus`. No existing
 * signature moved, so the interesting question is not whether the additions are
 * safe but whether the compositions they REPLACE still compile, and every one of
 * them is written out below:
 *
 * - **`useSessionStatus()` / `useSessionError()` replace two inline
 *   selectors**, and {@link StatusDot} and {@link ErrorBanner} are those
 *   selectors. They stay legal because `useSessionSelector` did not narrow:
 *   nothing stops a chrome selecting the same two fields by hand, it just
 *   rebuilds the selection memo per render (an inline arrow is a new selector
 *   every time), which is a cost rather than an error.
 * - **`AGENT_STATE_LABELS` replaces a hand-written record**, and
 *   {@link STATE_COLOR} is the shape that record had: `satisfies
 *   Record<AgentState, string>`. That annotation is the freeze worth having —
 *   a state ADDED to `AgentState` reddens here, which is the whole reason the
 *   published record exists, and it means this file also proves the union did
 *   not grow behind epoch 3's back.
 * - **`SessionActions` is a RENAME, not a new member.** `Session` was already
 *   `SessionSnapshot &` the same picked method set; epoch 4 gave that operand a
 *   name and exported it. Structurally the two are one type, so
 *   {@link Controls} — which annotates `Session` and reads four members off it
 *   — is the evidence that a consumer cannot tell the difference.
 * - **`useSessionActions()` replaces the whole-snapshot read for the actions**,
 *   and {@link Controls} is deliberately still that read. It is the shape epoch
 *   3 published as the only route to `start`/`toggle`/`restart`/`end`, so it has
 *   to keep working, cost and all.
 *
 * Nothing here names any of the five, which is the point — the file is evidence
 * about epoch 3's surface, not about the current one.
 *
 * ## The two RESULT types, and why they are annotated rather than inferred
 *
 * Unchanged from epoch 2, and unchanged for the same reason. `useConversation()`
 * and `useUserTranscript()` both answer a named type, and a chrome that only
 * destructures them freezes nothing: a field that CHANGED SHAPE would redden
 * wherever the value was used rather than here, if it reddened at all.
 * {@link rowCount} and {@link liveRow} take them as parameters and read them, so
 * a narrowed result type fails at the ANNOTATION, in the file whose job is to
 * notice. {@link Row} and {@link lastFromUser} do the same one layer down for
 * `ConversationItem` and `ChatMessage`.
 */

import type {
  AgentCustomEvent,
  AgentState,
  ChatMessage,
  ConversationItem,
  Session,
  SessionCore,
  SessionError,
  SessionErrorCode,
  SessionSnapshot,
  UseConversationResult,
  UseUserTranscriptResult,
  VoiceSessionOptions,
  WebSocketConstructor,
} from "../../../index.ts";
import {
  createSessionCore,
  useConversation,
  useSession,
  useSessionSelector,
  useUserTranscript,
} from "../../../index.ts";

/** The colour per state, as a chrome owning its own palette writes it. */
const STATE_COLOR = {
  disconnected: "#71717a",
  connecting: "#eab308",
  ready: "#22c55e",
  listening: "#22c55e",
  thinking: "#eab308",
  speaking: "#3b82f6",
  error: "#ef4444",
} as const satisfies Record<AgentState, string>;

/** A narrow subscription: this row re-renders when the state changes, not on every delta. */
function StatusDot() {
  const state = useSessionSelector((snapshot: SessionSnapshot) => snapshot.state);
  return <span style={{ color: STATE_COLOR[state] }}>{state}</span>;
}

/** The announced error banner every custom chrome owes. */
function ErrorBanner() {
  const error = useSessionSelector((snapshot: SessionSnapshot) => snapshot.error);
  if (!error) return null;
  const code: SessionErrorCode = error.code;
  return (
    <div role="alert">
      {error.message} ({code})
    </div>
  );
}

/** One row of the transcript, discriminated the way epoch 3 published it. */
function Row({ item }: { item: ConversationItem }) {
  if (item.kind === "tool") return <li>{item.toolCall.name}</li>;
  return <li>{item.message.content}</li>;
}

/**
 * How many rows this chrome is about to draw.
 *
 * A reader of the whole result rather than of a destructured field, which is
 * what freezes the type: `items` is the settled list and `streaming` is the row
 * that is not a member of it yet, so counting them together is a claim about
 * BOTH fields and about the `null`-between-turns convention on the second.
 */
export function rowCount(conversation: UseConversationResult): number {
  return conversation.items.length + (conversation.streaming === null ? 0 : 1);
}

/**
 * The caller's live row, or `null` when there is nothing to draw.
 *
 * The `null`-vs-`""` distinction stays where the hook made it: `speaking` is
 * what the row renders ON, and `text` already carries the one-character
 * placeholder for the few hundred milliseconds between speech being detected
 * and the first word arriving. A chrome re-deriving that from `partial` is the
 * mistake this result type exists to prevent, so the raw field is read only for
 * the silent case.
 */
export function liveRow(transcript: UseUserTranscriptResult): string | null {
  return transcript.speaking ? transcript.text : transcript.partial;
}

/** The conversation, plus the two live rows that are not yet items. */
function Transcript() {
  const conversation: UseConversationResult = useConversation();
  const { items, streaming, thinking } = conversation;
  const partial: UseUserTranscriptResult = useUserTranscript();
  const live = liveRow(partial);
  return (
    <>
      <p>{rowCount(conversation)} rows</p>
      <ul>
        {items.map((item) => (
          <Row item={item} key={item.kind === "tool" ? item.toolCall.callId : item.message.id} />
        ))}
        {live !== null && <li>{live}</li>}
        {streaming !== null && <li>{streaming}</li>}
        {thinking && <li>thinking…</li>}
      </ul>
    </>
  );
}

/**
 * The last thing the caller said, for a chrome that echoes it in its header.
 *
 * `messages` is user and assistant turns only — tool activity is its own log —
 * so the `role` narrowing here is the whole of what this type promises a
 * template, and it is why the SDK's three-role `Message` is a different type.
 */
export function lastFromUser(messages: readonly ChatMessage[]): string | null {
  return messages.filter((message) => message.role === "user").at(-1)?.content ?? null;
}

/** The header line, narrowly subscribed to the message log alone. */
function LastHeard() {
  const messages = useSessionSelector((snapshot: SessionSnapshot) => snapshot.messages);
  const said = lastFromUser(messages);
  return said === null ? null : <p>You said: {said}</p>;
}

/**
 * The agent's own events, as a chrome owning its cursor reads them.
 *
 * `customEvents` is a LOG rather than a value — `useEvent(name, cb)` is the
 * reader that delivers each one exactly once — so a component rendering the
 * array directly is choosing to own the cursor, which is the case this file
 * freezes: the `id` it keys on is the counter that makes that possible.
 */
function EventLog() {
  const events = useSessionSelector((snapshot: SessionSnapshot) => snapshot.customEvents);
  return (
    <ol>
      {events.map((custom: AgentCustomEvent) => (
        <li key={custom.id}>{custom.event}</li>
      ))}
    </ol>
  );
}

/**
 * The control row — the one place an epoch-3 chrome reads the whole session,
 * because the actions live on it and `useSessionActions` did not exist yet.
 *
 * Four members off one annotated {@link Session}, `restart` among them, which
 * is what makes this the epoch-3 version rather than epoch 2's: `restart()` is
 * "New Conversation" for an agent with session-scoped state — it drops the
 * session id, where `reset()` reconnects carrying it — and epoch 3 is the first
 * epoch that published it.
 */
function Controls() {
  const session: Session = useSession();
  return (
    <div>
      <button onClick={session.started ? session.toggle : session.start} type="button">
        {session.running ? "Stop" : "Start"}
      </button>
      <button onClick={session.restart} type="button">
        New Conversation
      </button>
      <button onClick={session.end} type="button">
        End
      </button>
    </div>
  );
}

/** The whole chrome, as a template's `component:` would export it. */
export function Chrome() {
  return (
    <main>
      <StatusDot />
      <ErrorBanner />
      <LastHeard />
      <Transcript />
      <EventLog />
      <Controls />
    </main>
  );
}

/**
 * A session built the way epoch 3 published — through the FACTORY.
 *
 * `createSessionCore` answers a `SessionCore`, so a caller receives every
 * member the current type has and cannot be missing one. That is the direction
 * that survives a member being added; annotating a hand-written literal is the
 * shape a later epoch breaks, and no epoch has advertised it as the way in.
 *
 * The socket is a PARAMETER for the same reason. `VoiceSessionOptions.WebSocket`
 * is the one documented seam a spec has into a live session — an injected
 * constructor is used as-is and never reconnects on its own, where the default
 * is a reconnecting socket that resumes — so taking it here freezes the shape
 * the option accepts rather than the `globalThis.WebSocket` that happens to
 * satisfy it today.
 */
export function makeCore(options: VoiceSessionOptions, socket: WebSocketConstructor): SessionCore {
  return createSessionCore({ ...options, WebSocket: socket });
}

/**
 * Is a socket this session was handed already open?
 *
 * The `OPEN` member is the half of {@link WebSocketConstructor} that is easy to
 * forget: it is a STATIC on the constructor, not on an instance, and a caller
 * passing a mock that implements only `new` compiles everywhere except here.
 */
export function isOpen(socket: WebSocketConstructor, live: WebSocket): boolean {
  return live.readyState === socket.OPEN;
}

/** An epoch-3 reader of the error union, kept honest by the annotation. */
export function describe(error: SessionError | null): string {
  return error === null ? "ok" : `${error.code}: ${error.message}`;
}
