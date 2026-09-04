// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:session-state` epoch 2.
 *
 * A host CONSUMING the store it was handed — the other side of `v1.ts`, which
 * implements the backend. Written the way it was authored at epoch 2, and it must
 * keep compiling for as long as that epoch is advertised as supported.
 *
 * ## What moved, and why epoch 2 survives it
 *
 * Epoch 3 added `ensureSessionStateSchema`: the DDL applier a self-hosted operator
 * calls at boot, because the session-state tables come with whoever OWNS the
 * database and a self-hosted server is that owner with no migration step to hang
 * them off. Until then the capability was two types and no way to create anything,
 * so a `DATABASE_URL` handed to `createAgentServer` reported `sessionState:
 * postgres` and then failed every session at start on a missing relation.
 *
 * ADDING an export is not breaking in either direction — nothing below names it,
 * and nothing that did not name it can start disagreeing about it — which is what
 * makes this a retain rather than a drop.
 *
 * The direction that WOULD break is a change to either type: `SessionStateBackend`
 * gaining a member breaks an IMPLEMENTOR (v1.ts is the example that would redden),
 * and `SessionStateStore` losing one breaks a CONSUMER, which is this file.
 *
 * Editing this file to make a future error go away defeats the mechanism: the error
 * IS the finding, and it means epoch 2 has to be dropped with a reason.
 */

import type { SessionStateBackend, SessionStateStore } from "../../../runtime-barrel.ts";

/**
 * The line a host prints at boot about where this deployment keeps session state.
 *
 * `backend` is deliberately the NARROW pair rather than the whole backend: a host
 * may report which tier it is in and may not reach past that to the store's own
 * reads and writes.
 */
export function describeSessionState(store: SessionStateStore): string {
  const { name, durable } = store.backend;
  return durable
    ? `session state: ${name} (survives a restart)`
    : `session state: ${name} — IN MEMORY, lost when this process exits`;
}

/**
 * Bring a reconnecting caller's session back, and say whether anything was there.
 *
 * `hydrate` is the only call here that can reject, and a host has to decide what
 * that means: this one lets it through, because a session started against state
 * that failed to load is an agent that has silently forgotten the cart.
 */
export async function resumeSession(
  store: SessionStateStore,
  sessionId: string,
): Promise<{ resumed: boolean }> {
  await store.hydrate(sessionId);
  return { resumed: store.has(sessionId) };
}

/**
 * End a session the way a host owns it: commit what changed, then reclaim.
 *
 * `flush` never rejects — a failed commit is logged and costs durability, not the
 * call — so there is nothing to catch, and `discard` is synchronous because
 * reclaiming is fire-and-forget by contract.
 */
export async function endSession(store: SessionStateStore, sessionId: string): Promise<void> {
  await store.flush(sessionId);
  store.discard(sessionId);
}

/**
 * A backend that WRAPS another to count its writes — the shape a host reaches for
 * to meter a tenant, and the reason `SessionStateBackend` is received as well as
 * implemented.
 *
 * Spread-then-override rather than a hand-written object, so a member added to the
 * interface reaches the delegate instead of failing here. That is a decorator's
 * privilege and not an implementor's: v1.ts writes every member out, which is why
 * it is the file that reddens when the interface grows.
 */
export function countingBackend(
  inner: SessionStateBackend,
  onCommit: (sessionId: string, slots: number) => void,
): SessionStateBackend {
  return {
    ...inner,
    async commit(sessionId, values) {
      await inner.commit(sessionId, values);
      onCommit(sessionId, values.size);
    },
  };
}
