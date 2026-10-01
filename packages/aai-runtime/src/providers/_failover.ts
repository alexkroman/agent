// Copyright 2026 the AAI authors. MIT license.
/**
 * The one vocabulary every stage's failover reports in, and the seam a session
 * receives it through.
 *
 * Resolution is per RUNTIME (one opener / one `LanguageModel` serves every
 * session), but a failover is a fact about ONE session. So a fallback provider
 * never holds a listener of its own: the pipeline transport binds one per
 * session (`withOpenerFailoverListener` here, `withFailoverListener` in
 * `_fallback-llm.ts`), and reports what it hears as a `provider.failedOver`
 * session event.
 */

import { MAX_FAILOVER_REASON_CHARS } from "@alexkroman1/aai/host-internal";
import { errorMessage } from "@alexkroman1/aai/utils";

/** One switch from a failed member to the next — the body of `provider.failedOver`. */
export type ProviderFailover = {
  readonly stage: "stt" | "llm" | "tts";
  /** The member's `kind` that failed. */
  readonly from: string;
  /** The member's `kind` tried next. */
  readonly to: string;
  /** Why `from` was abandoned — the error's message. */
  readonly reason: string;
};

/** Where a fallback provider reports a switch. */
export type FailoverListener = (failover: ProviderFailover) => void;

/** Build a failover report, its reason bounded. */
export function failoverOf(
  stage: ProviderFailover["stage"],
  from: string,
  to: string,
  cause: unknown,
): ProviderFailover {
  return { stage, from, to, reason: errorMessage(cause).slice(0, MAX_FAILOVER_REASON_CHARS) };
}

/**
 * The one "move on to the next member" decision every stage makes after
 * member `i` failed with `cause`: report the switch and answer `true`, or
 * answer `false` — the call was aborted, or no member is left — so the caller
 * surfaces `cause` as a lone provider would.
 */
export function advanceFailover(
  stage: ProviderFailover["stage"],
  members: readonly { readonly kind: string }[],
  i: number,
  cause: unknown,
  aborted: boolean,
  onFailover: FailoverListener,
): boolean {
  const next = members[i + 1];
  if (aborted || next === undefined) return false;
  onFailover(failoverOf(stage, members[i]?.kind ?? "", next.kind, cause));
  return true;
}

/** An opener that can report failovers to the session opening it. */
export interface FailoverAwareOpener<Options, Session> {
  openReporting(options: Options, onFailover: FailoverListener): Promise<Session>;
}

/**
 * `opener` bound to one session's listener: every `open()` reports its
 * failovers there. A non-fallback opener is returned as-is (by identity), so
 * the transport that holds the result needs no branch and no new option.
 */
export function withOpenerFailoverListener<Options, Session>(
  opener: { readonly name: string; open(options: Options): Promise<Session> },
  onFailover: FailoverListener,
): { readonly name: string; open(options: Options): Promise<Session> } {
  const aware = opener as Partial<FailoverAwareOpener<Options, Session>>;
  if (typeof aware.openReporting !== "function") return opener;
  const { openReporting } = aware;
  return {
    name: opener.name,
    open: (options) => openReporting.call(opener, options, onFailover),
  };
}
