// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:session` epoch 2.
 *
 * A custom chrome as it was authored at epoch 2 — the shape the three
 * custom-chrome templates share: a narrowly-subscribed status line, a
 * conversation built from `useConversation`, the user's live partial from
 * `useUserTranscript`, the agent's own event log, and one whole-session read
 * for the control row. It must keep compiling for as long as epoch 2 is
 * advertised as supported.
 *
 * ## What moved, and why epoch 2 survives it
 *
 * Epoch 3 added `restart()` to {@link SessionCore}, and therefore to
 * {@link Session}, which is `SessionSnapshot & Pick<SessionCore, …>`. The
 * addition is safe in exactly one direction, and this file is written to prove
 * it is the direction that matters:
 *
 * - **A CONSUMER of the type cannot break.** {@link Controls} below reads
 *   `start`, `toggle` and `end` off `useSession()` and never mentions
 *   `restart`. A type gaining a member is widening in the direction a reader
 *   sits, so every epoch-2 call site keeps compiling and keeps meaning what it
 *   meant.
 * - **An IMPLEMENTOR would break, and epoch 2 published no way to be one.**
 *   `SessionCore` is a type a consumer receives from `createSessionCore`; a
 *   hand-built object literal annotated `SessionCore` would now be missing a
 *   member. That is a real break for anyone who wrote a test double by
 *   annotation — which is why this file constructs one through the FACTORY
 *   ({@link makeCore}) rather than as a literal. An epoch-2 author writing the
 *   literal is outside what this example promises, and deliberately so: the
 *   package's own mock had to gain the member when `restart` landed.
 *
 * Nothing here names `restart`, `useSessionCore` or anything else added since,
 * which is the point — the file is evidence about epoch 2's surface, not about
 * the current one.
 *
 * ## The two RESULT types, and why they are annotated rather than inferred
 *
 * `useConversation()` and `useUserTranscript()` both answer a named type, and a
 * chrome that only destructures them freezes nothing: the names would resolve,
 * the fields would be read, and a field that CHANGED SHAPE — `transcript`
 * becoming a bare string, `items` losing its discriminant — would redden
 * wherever the value was used rather than here, if it reddened at all.
 * {@link rowCount} and {@link liveRow} take them as parameters and read them
 * instead, which is the direction that pins the promise: a narrowed result type
 * fails at the ANNOTATION, in the file whose job is to notice.
 *
 * The same is true one layer down. {@link Row} reads a `ConversationItem`'s
 * discriminant and {@link lastFromUser} reads a `ChatMessage`'s `role` and
 * `content`, so the two types a transcript is BUILT from are frozen by what is
 * done with them and not merely by being mentioned.
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

/** One row of the transcript, discriminated the way epoch 2 published it. */
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
 * The control row — the one place an epoch-2 chrome reads the whole session,
 * because the actions live on it. It names three methods and no more.
 */
function Controls() {
  const session: Session = useSession();
  return (
    <div>
      <button onClick={session.started ? session.toggle : session.start} type="button">
        {session.running ? "Stop" : "Start"}
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
 * A session built the way epoch 2 published — through the FACTORY.
 *
 * The distinction this file's doc draws: `createSessionCore` answers a
 * `SessionCore`, so a caller receives every member the current type has and
 * cannot be missing one. Annotating a hand-written literal is the shape that
 * epoch 3 broke, and epoch 2 never advertised it as the way in.
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

/** An epoch-2 reader of the error union, kept honest by the annotation. */
export function describe(error: SessionError | null): string {
  return error === null ? "ok" : `${error.code}: ${error.message}`;
}
