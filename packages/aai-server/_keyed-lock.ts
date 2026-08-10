// Copyright 2026 the AAI authors. MIT license.
/**
 * The platform's keyed mutex — re-exported from the SDK, which owns the
 * implementation (`aai/sdk/keyed-lock.ts`).
 *
 * It lived here first, and moved when the studio templates turned out to need
 * the same primitive: an agent author hits this hazard as directly as the
 * platform does, because the LLM loop runs a step's tool calls concurrently.
 * Two hand-rolled copies in shipped templates were the evidence that it
 * belonged on a public subpath.
 *
 * What is platform-specific, and why this module still exists to say it:
 *
 * - **Entries are deleted as the chain drains**, unlike p-lock, whose per-key
 *   entry leaks for the life of the process. That matters here because the
 *   slug lock is taken PRE-AUTH on WebSocket upgrades, which makes p-lock's
 *   leak attacker-growable.
 * - **Acquiring can carry a DEADLINE**, which is what makes a contended
 *   mutation answerable. The cross-replica half of the slug lock has always
 *   had one (`lock_timeout` on the reserved connection → `55P03` → 409), but
 *   it sits BEHIND this mutex — see platform-lock.ts — so a second mutation of
 *   the same slug on the SAME replica never reached it and queued here
 *   unbounded instead.
 */

export {
  createKeyedLock,
  type KeyedLock,
  type KeyedLockOptions,
  KeyedLockTimeoutError,
  withLock,
} from "@alexkroman1/aai/utils";
