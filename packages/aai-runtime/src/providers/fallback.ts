// Copyright 2026 the AAI authors. MIT license.
/**
 * The host half of `fallback([...])` for the two SOCKET stages, STT and TTS.
 * (The LLM half is `_fallback-llm.ts`; the SDK's `providers/fallback.ts`
 * declares the descriptor and documents the policy for authors.)
 *
 * ## When a member is abandoned
 *
 * Only while the session has produced nothing from it — the rule that keeps a
 * caller from hearing one vendor's half-sentence finished by another's:
 *
 * 1. **`open()` rejects** (connect, auth, refused handshake, the connect
 *    deadline): the next member is opened in its place.
 * 2. **The open session emits `error` before its first OUTPUT** — a `partial`
 *    or `final` for STT, `audio` for TTS. The failed session is closed and the
 *    next member opened behind the SAME wrapper, so the transport, which has
 *    already subscribed, never sees the swap. Audio sent to STT while the next
 *    member connects is dropped (a caller who spoke into a dead socket was not
 *    heard either); text sent to TTS since the session opened is REPLAYED into
 *    the next member, because it is the greeting the caller is waiting on.
 *
 * Never on an abort (the session's signal), and never after output: from then
 * on an `error` is forwarded exactly as a lone provider's would be. When every
 * member has failed, the LAST member's error is the stage's — a rejection from
 * `open()`, or an `error` event from the wrapper.
 *
 * Each switch is reported through the `FailoverListener` the transport hands
 * to `openReporting` (see `_failover.ts`); plain `open()` reports to nobody.
 *
 * ## Credentials
 *
 * Every member reads its OWN key: `env[member.envVar]` when the resolver was
 * given the provider env (the runtime always gives it), else the key the
 * caller passed to `open()`.
 */

import type { ProviderEnv } from "@alexkroman1/aai/host-internal";
import { errorMessage } from "@alexkroman1/aai/utils";
import {
  type FailoverAwareOpener,
  type FailoverListener,
  failoverOf,
  type ProviderFailover,
} from "./_failover.ts";
import {
  createSttError,
  createTtsError,
  type SttEvents,
  type SttOpener,
  type SttOpenOptions,
  type SttSession,
  type TtsEvents,
  type TtsOpener,
  type TtsOpenOptions,
  type TtsSession,
  type Unsubscribe,
} from "./openers.ts";

/** A resolved member: its opener, the variable its key is in, and its kind. */
export type FallbackMember<Opener> = {
  readonly opener: Opener;
  readonly envVar: string;
  readonly kind: string;
};

/** Any event map's handlers — `never[]` parameters, so every concrete handler fits. */
type Handlers = Record<string, (...args: never[]) => void>;

/** A listener table — the wrapper's own `on`, independent of which member is live. */
function listenerTable<E extends Handlers>(): {
  on<K extends keyof E>(event: K, fn: E[K]): Unsubscribe;
  emit<K extends keyof E>(event: K, call: (fn: E[K]) => void): void;
} {
  const table = new Map<keyof E, Set<unknown>>();
  return {
    on(event, fn) {
      const set = table.get(event) ?? new Set();
      table.set(event, set);
      set.add(fn);
      return () => set.delete(fn);
    },
    emit(event, call) {
      // Each set holds only the handlers `on` stored under this same key.
      for (const fn of [...(table.get(event) ?? [])]) call(fn as E[typeof event]);
    },
  };
}

/** The key member `i` opens with. */
function keyFor(
  member: { envVar: string },
  env: ProviderEnv | undefined,
  fallbackKey: string,
): string {
  return env === undefined ? fallbackKey : (env[member.envVar] ?? "");
}

/**
 * Walk the members from `start`, answering the first that opens and reporting
 * each one skipped.
 */
async function openFrom<M extends { readonly kind: string }, Session>(
  members: readonly M[],
  start: number,
  open: (member: M) => Promise<Session>,
  signal: AbortSignal,
  report: (failover: ProviderFailover) => void,
  stage: ProviderFailover["stage"],
): Promise<{ session: Session; index: number }> {
  let lastError: unknown = new Error(`${stage.toUpperCase()} fallback has no member to open.`);
  for (let i = start; i < members.length; i++) {
    const member = members[i];
    if (member === undefined) break;
    try {
      return { session: await open(member), index: i };
    } catch (err) {
      lastError = err;
      const next = members[i + 1];
      if (signal.aborted || next === undefined) break;
      report(failoverOf(stage, member.kind, next.kind, err));
    }
  }
  throw lastError;
}

/** What a stage tells the core about one adopted member's events. */
type MemberHooks = {
  /** The member produced output: from now on its errors are the turn's. */
  output(): void;
  /** The member reported an error; `forward` hands it on unchanged. */
  error(err: unknown, forward: () => void): void;
};

/** The live member of one fallback session, as the stage's wrapper reads it. */
type FailoverCore<Session> = {
  current(): Session | null;
  produced(): boolean;
  /** The member the session opened with — whose optional controls it claims. */
  readonly first: Session;
  close(): Promise<void>;
};

/**
 * The state machine both socket stages share: open the first member that
 * opens, subscribe it through the stage's `wire`, and on an error before any
 * output close it and adopt the next behind the same wrapper. `adopted` runs
 * after each adoption (TTS replays what it was sent); `connectError` reports
 * a list that ran out after the session had opened.
 */
async function openFailoverCore<
  M extends { readonly kind: string },
  Session extends { close(): Promise<void> },
>(args: {
  stage: ProviderFailover["stage"];
  members: readonly M[];
  open: (member: M) => Promise<Session>;
  signal: AbortSignal;
  onFailover: FailoverListener;
  wire: (session: Session, hooks: MemberHooks) => Unsubscribe[];
  adopted?: (session: Session) => void;
  connectError: (message: string) => void;
}): Promise<FailoverCore<Session>> {
  const { stage, members, signal, onFailover } = args;
  let current: Session | null = null;
  let index = 0;
  let produced = false;
  let closed = false;
  let subs: Unsubscribe[] = [];

  const adopt = (session: Session, at: number): void => {
    current = session;
    index = at;
    subs = args.wire(session, {
      output: () => {
        produced = true;
      },
      error: (err, forward) => {
        const next = members[index + 1];
        if (produced || closed || signal.aborted || next === undefined) {
          forward();
          return;
        }
        onFailover(failoverOf(stage, members[index]?.kind ?? "", next.kind, err));
        void switchFrom(session, index + 1);
      },
    });
    args.adopted?.(session);
  };

  const switchFrom = async (failed: Session, start: number): Promise<void> => {
    for (const off of subs) off();
    current = null;
    await failed.close().catch(() => undefined);
    try {
      const next = await openFrom(members, start, args.open, signal, onFailover, stage);
      if (closed || signal.aborted) await next.session.close().catch(() => undefined);
      else adopt(next.session, next.index);
    } catch (err) {
      if (!closed) args.connectError(errorMessage(err));
    }
  };

  const first = await openFrom(members, 0, args.open, signal, onFailover, stage);
  adopt(first.session, first.index);
  return {
    current: () => current,
    produced: () => produced,
    first: first.session,
    async close() {
      closed = true;
      for (const off of subs) off();
      await current?.close();
    },
  };
}

/** The member half of a core's arguments: each member opened with its own key. */
function membersOf<Options extends { apiKey: string; signal: AbortSignal }, Session>(
  members: readonly FallbackMember<{ open(options: Options): Promise<Session> }>[],
  env: ProviderEnv | undefined,
  options: Options,
  onFailover: FailoverListener,
) {
  return {
    members,
    open: (m: FallbackMember<{ open(options: Options): Promise<Session> }>) =>
      m.opener.open({ ...options, apiKey: keyFor(m, env, options.apiKey) }),
    signal: options.signal,
    onFailover,
  };
}

/** The opener a stage's `openReporting` becomes: named by its members, silent by default. */
function fallbackOpener<Options, Session>(
  members: readonly { readonly kind: string }[],
  openReporting: (options: Options, onFailover: FailoverListener) => Promise<Session>,
): {
  readonly name: string;
  open(options: Options): Promise<Session>;
} & FailoverAwareOpener<Options, Session> {
  return {
    name: `fallback(${members.map((m) => m.kind).join(",")})`,
    open: (options) => openReporting(options, () => undefined),
    openReporting,
  };
}

/** A fallback STT opener over resolved members, in order. */
export function createFallbackSttOpener(
  members: readonly FallbackMember<SttOpener>[],
  env: ProviderEnv | undefined,
): SttOpener & FailoverAwareOpener<SttOpenOptions, SttSession> {
  return fallbackOpener(members, async (options: SttOpenOptions, onFailover) => {
    const out = listenerTable<SttEvents>();
    const core = await openFailoverCore({
      stage: "stt",
      ...membersOf(members, env, options, onFailover),
      wire: (session, hooks) => [
        session.on("partial", (text, meta) => {
          hooks.output();
          out.emit("partial", (fn) => fn(text, meta));
        }),
        session.on("final", (text, meta) => {
          hooks.output();
          out.emit("final", (fn) => fn(text, meta));
        }),
        session.on("error", (err) => hooks.error(err, () => out.emit("error", (fn) => fn(err)))),
      ],
      connectError: (message) =>
        out.emit("error", (fn) => fn(createSttError("stt_connect_failed", message))),
    });
    const wrapper: SttSession = {
      sendAudio: (pcm) => core.current()?.sendAudio(pcm),
      on: (event, fn) => out.on(event, fn),
      close: () => core.close(),
    };
    // The optional controls are the ADOPTED member's: a transport reads their
    // presence as "this provider can", so the wrapper claims only what the
    // session it opened with claims, and forwards to whichever member is live.
    if (core.first.updateEndpointing) {
      wrapper.updateEndpointing = (ms) => core.current()?.updateEndpointing?.(ms);
    }
    if (core.first.forceEndOfTurn) {
      wrapper.forceEndOfTurn = () => core.current()?.forceEndOfTurn?.();
    }
    return wrapper;
  });
}

/** One call made on a TTS session before its first audio — what a switch replays. */
type TtsCall =
  | { readonly method: "sendText"; readonly text: string }
  | { readonly method: "flush" };

/** A fallback TTS opener over resolved members, in order. */
export function createFallbackTtsOpener(
  members: readonly FallbackMember<TtsOpener>[],
  env: ProviderEnv | undefined,
): TtsOpener & FailoverAwareOpener<TtsOpenOptions, TtsSession> {
  return fallbackOpener(members, async (options: TtsOpenOptions, onFailover) => {
    const out = listenerTable<TtsEvents>();
    // Everything sent since the session opened, until the first audio: what a
    // member that failed before speaking never got to say.
    const pending: TtsCall[] = [];
    const core = await openFailoverCore({
      stage: "tts",
      ...membersOf(members, env, options, onFailover),
      wire: (session, hooks) => [
        session.on("audio", (pcm) => {
          hooks.output();
          pending.length = 0;
          out.emit("audio", (fn) => fn(pcm));
        }),
        session.on("words", (words) => out.emit("words", (fn) => fn(words))),
        session.on("done", () => out.emit("done", (fn) => fn())),
        session.on("error", (err) => hooks.error(err, () => out.emit("error", (fn) => fn(err)))),
      ],
      adopted: (session) => {
        for (const call of pending) {
          if (call.method === "sendText") session.sendText(call.text);
          else session.flush();
        }
      },
      connectError: (message) =>
        out.emit("error", (fn) => fn(createTtsError("tts_connect_failed", message))),
    });
    const record = (call: TtsCall): void => {
      if (!core.produced()) pending.push(call);
    };
    return {
      sendText(text) {
        record({ method: "sendText", text });
        core.current()?.sendText(text);
      },
      flush() {
        record({ method: "flush" });
        core.current()?.flush();
      },
      cancel() {
        // A cancelled turn is not replayed into a successor.
        pending.length = 0;
        core.current()?.cancel();
      },
      on: (event, fn) => out.on(event, fn),
      close: () => core.close(),
    };
  });
}
