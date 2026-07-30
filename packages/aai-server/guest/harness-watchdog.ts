// Copyright 2026 the AAI authors. MIT license.
/**
 * Orphan watchdog for the guest harness: calls `onOrphaned` once when no host
 * traffic has been seen for `timeoutMs`. Any inbound stdin line — heartbeat
 * `ping`s included — counts as traffic via `touch()`.
 *
 * This is the guest's own guarantee that a dead host cannot leave it running:
 * stdin EOF is not reliably delivered when the host process is killed (the
 * exec's stdin is a message-streamed handle, and a dead client never sends
 * the close), and a harness that never exits keeps its Modal sandbox alive to
 * the 4h lifetime cap. The host feeds this watchdog with periodic `ping`
 * notifications (see HARNESS_HEARTBEAT_INTERVAL_MS in limits.ts).
 *
 * Sibling of deno-harness.ts: inlined by the bundler into the guest artifact,
 * so it must stay free of workspace imports (limits.ts is a sibling).
 */

import { HARNESS_ORPHAN_POLL_MS, HARNESS_ORPHAN_TIMEOUT_MS } from "./limits.ts";

export function createOrphanWatchdog(cfg: {
  onOrphaned: () => void;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
}): { touch: () => void; stop: () => void } {
  const timeoutMs = cfg.timeoutMs ?? HARNESS_ORPHAN_TIMEOUT_MS;
  const pollMs = cfg.pollMs ?? HARNESS_ORPHAN_POLL_MS;
  const now = cfg.now ?? (() => Date.now());
  let lastSeenAt = now();
  const timer = setInterval(() => {
    if (now() - lastSeenAt <= timeoutMs) return;
    clearInterval(timer);
    cfg.onOrphaned();
  }, pollMs);
  return {
    touch: () => {
      lastSeenAt = now();
    },
    stop: () => clearInterval(timer),
  };
}
