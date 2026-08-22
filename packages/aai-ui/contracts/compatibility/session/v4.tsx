// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:session` epoch 4.
 *
 * See `../client/v1.tsx` for what "frozen" obliges and why the imports are
 * relative.
 *
 * Epoch 4 took `VOICE_CAPTURE_CONSTRAINTS` off the root barrel — a framework
 * decision with no `client()` field to set, named by no `client.tsx` in the
 * tree, and now on `@alexkroman1/aai-ui/internal` beside the providers a chrome
 * that bypasses `client()` also needs. Epochs 2 and 3 (`./v2.tsx`, `./v3.tsx`)
 * are retained and compile unchanged.
 *
 * It is also where `useSession` gained an example. The two epochs before this
 * one froze the caller's in-progress turn and the headless `createSessionCore`
 * path, and left out the hook every custom chrome in `templates/` is written
 * against — so the gate guarded the path with no consumers and not the one with
 * three. This file is that: the whole snapshot, the controls that come with it,
 * and the state union rendered exhaustively.
 */

import { type AgentState, type ChatMessage, type Session, useSession } from "../../../index.ts";

/**
 * The dot's colour per session state, as an EXHAUSTIVE map.
 *
 * `satisfies Record<AgentState, string>` is what borrows the union: a state
 * added to it stops compiling here, where an `if`-chain with a grey default
 * would answer a new state silently. Three templates paint their status
 * indicator exactly this way.
 */
const STATE_COLORS = {
  disconnected: "#6b7280",
  connecting: "#6b7280",
  ready: "#22c55e",
  listening: "#22c55e",
  thinking: "#eab308",
  speaking: "#3b82f6",
  error: "#6b7280",
} satisfies Record<AgentState, string>;

/** One `useSession()` call is the snapshot AND the controls over it. */
export function CallBar() {
  const session: Session = useSession();
  const state: AgentState = session.state;

  if (!session.started) {
    return (
      <button type="button" onClick={session.start}>
        Start
      </button>
    );
  }

  return (
    <div>
      <span style={{ background: STATE_COLORS[state] }} />
      <button type="button" onClick={session.toggle}>
        {session.running ? "Pause" : "Resume"}
      </button>
      <button type="button" onClick={session.end}>
        Hang up
      </button>
    </div>
  );
}

/** The snapshot half on its own, for a chrome that renders the transcript. */
export function Transcript() {
  const { messages, state } = useSession();
  const history: readonly ChatMessage[] = messages;
  return (
    <ol aria-busy={state === "thinking"}>
      {history.map((message) => (
        <li key={message.id} data-role={message.role}>
          {message.content}
        </li>
      ))}
    </ol>
  );
}
