// Copyright 2026 the AAI authors. MIT license.
// The chat-availability footnote shared by the home hero and the empty chat
// state, so the user-facing wording lives once.

import type { StudioStatus } from "./api.ts";

type ChatStatusNoteProps = {
  /** Undefined while `/studio/status` is loading or unreachable. */
  status: StudioStatus | undefined;
};

/**
 * Say what the UI is waiting for while `/studio/status` is in flight. Chat
 * itself is unconditional — it runs on the caller's own key — so once the
 * status lands there is nothing left to report and this renders nothing.
 */
export function ChatStatusNote({ status }: ChatStatusNoteProps) {
  if (status !== undefined) return null;
  return <p className="m-0 text-xs leading-4 text-subtle">Checking the server's chat status…</p>;
}
