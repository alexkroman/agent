// Copyright 2026 the AAI authors. MIT license.
/**
 * The one journal rejection that is a verdict about the RUN.
 *
 * Its own module rather than more of `workflow-journal-types.ts`, which sits
 * against the 500-line cap: this is a CLASS three backends construct and the
 * engine narrows on, where everything left there is the shape of what is stored
 * and the interface over it. Re-exported from that module, so an importer's
 * path is unchanged and a reader still finds it beside the method whose contract
 * names it.
 *
 * @module
 */

/**
 * A journal call the store REFUSED on the run's own merits.
 *
 * The one class of journal rejection that is a verdict about the RUN rather than
 * about the store, and it needs its own type because those two want opposite
 * handling: a store that is unreachable means the run's state is UNKNOWN, so the
 * delivery fails and the queue retries it, where a refusal cannot change however
 * many times it is retried and the right move is to fail the run and say why.
 * `workflow-replay-journal-failure.ts` is what reads the difference.
 *
 * Everything else a store may reject with — a reset socket, an exhausted pool, a
 * full disk, a timeout — is the store, so the set here is CLOSED and small
 * rather than a classification of driver errors. Today it has exactly one
 * member, {@link JournalStore.claimHook}'s token conflict, which is the only
 * throw this interface documents as "a bug worth failing the run over".
 *
 * Every backend must raise it for that case or the arms disagree about whether a
 * conflicted run fails or is retried forever — the platform arm already had the
 * distinction as an HTTP status (409, versus the retryable statuses that carry
 * `PLATFORM_UNAVAILABLE_CODE`), and this is that same line drawn once for all
 * four.
 */
export class JournalConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JournalConflictError";
  }

  /**
   * Is this value one? A static rather than `instanceof` at each site, because
   * a deployed guest holds TWO copies of this package — see
   * `packages/aai-runtime/CLAUDE.md`, "A deployed guest has TWO copies" — so a
   * cross-copy `instanceof` is false for an error the other copy constructed.
   */
  static is(value: unknown): value is JournalConflictError {
    return value instanceof Error && value.name === "JournalConflictError";
  }
}
