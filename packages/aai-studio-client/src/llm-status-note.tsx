// Copyright 2026 the AAI authors. MIT license.
// The LLM-availability footnote shared by the home hero and the empty chat
// state, so the user-facing wording (and the key-name list in it) lives once.

import clsx from "clsx";
import type { StudioStatus } from "./api.ts";

type LlmStatusNoteProps = {
  /** Undefined while `/studio/status` is loading or unreachable. */
  status: StudioStatus | undefined;
  /** Extra classes for the disabled notice (the hero centers and caps it). */
  className?: string;
};

/**
 * No status yet is loading or a network failure — either way, don't claim
 * the server is misconfigured. Only a definite `llm: false` says so.
 */
export function LlmStatusNote({ status, className }: LlmStatusNoteProps) {
  if (status === undefined) {
    return <p className="m-0 text-xs leading-4 text-subtle">Checking the server's chat status…</p>;
  }
  if (!status.llm) {
    return (
      <p className={clsx("m-0 text-xs leading-4 text-subtle", className)}>
        Chat is disabled: this server has no LLM key (ASSEMBLYAI_API_KEY or ANTHROPIC_API_KEY). The
        Code view and Publish still work.
      </p>
    );
  }
  return null;
}
