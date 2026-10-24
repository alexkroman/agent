// Copyright 2026 the AAI authors. MIT license.
/**
 * Who mints a fresh session's id.
 *
 * `crypto.randomUUID()` unless a HOST says otherwise. The one host that does is
 * `aai start --workers`: its primary routes a connection by hashing the session
 * id it names, so a worker mints ids that hash to ITSELF — and a resume that
 * presents only the id reaches the worker holding the session, with no table of
 * ids anywhere. Module state on purpose: the minter belongs to the PROCESS
 * (one worker, one slot), like the provider registries.
 *
 * A minter must return a fresh, unguessable id each call; the id is the resume
 * handle for an unauthenticated session.
 *
 * @module
 */

let minter: (() => string) | undefined;

/**
 * Replace how this process mints a fresh session's id; `undefined` restores
 * `crypto.randomUUID()`.
 *
 * @internal
 */
export function setSessionIdMinter(mint: (() => string) | undefined): void {
  minter = mint;
}

/** A fresh session id. @internal */
export function mintSessionId(): string {
  return minter?.() ?? crypto.randomUUID();
}
