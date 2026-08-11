// Copyright 2026 the AAI authors. MIT license.
/**
 * The S2S transport's COLD-resume policy — rejoining a provider session that
 * a previous PROCESS opened.
 *
 * The transport already resumes across a dropped provider socket: it holds the
 * id from `session.ready` in a closure and replays it as `session.resume` on a
 * transient close. That covers the link going away and nothing else, because
 * the id lives in the process. Durable resume (see host/session-store.ts)
 * carries the id across a restart, and this module is the small amount of
 * state that makes the opening connect able to use it.
 *
 * **The two resumes must fail differently, which is the whole reason this is
 * its own thing rather than another boolean beside `reconnecting`.** A
 * mid-session resume that is refused has lost a live conversation — there is
 * nothing left to salvage, so it is fatal. A cold one has lost nothing: the
 * client is still completing its first handshake and replays its history
 * frame, and the service only keeps a session ~30s after a disconnect, so a
 * restart outlasting that is the ORDINARY case rather than an error. Treating
 * it as fatal would end calls that a plain `session.update` would have served
 * fine, making durable resume strictly worse than no resume at all.
 */

/** The opening-connect resume state for one transport. */
export type ColdResume = {
  /**
   * The previous process's provider session id, or undefined when there is
   * none to present.
   *
   * Answers at most once per transport, and that latch is load-bearing: the
   * refusal path re-enters `start()` to open a fresh session, and a second
   * read would re-attempt the id that was just refused, forever.
   */
  take(): string | undefined;
  /** Mark the opening connect as a cold resume (a `take()` returned an id). */
  begin(): void;
  /** True while that connect is still in flight — i.e. not yet ready or refused. */
  active(): boolean;
  /** Clear the flag, reporting whether it had been set. */
  end(): boolean;
};

/**
 * Create the cold-resume state over `read` — the caller's
 * `S2sTransportOptions.resumeProviderSession` thunk, which is absent whenever
 * durable resume is not configured.
 *
 * @internal
 */
export function createColdResume(read: (() => string | undefined) | undefined): ColdResume {
  let taken = false;
  let active = false;
  return {
    take() {
      if (taken) return;
      taken = true;
      const prior = read?.();
      // An empty string is treated as absent rather than presented: it is what
      // a store round-trip yields for a missing id, and the service would
      // reject it as a malformed resume rather than as an expired one.
      return prior === undefined || prior === "" ? undefined : prior;
    },
    begin() {
      active = true;
    },
    active: () => active,
    end() {
      const was = active;
      active = false;
      return was;
    },
  };
}
