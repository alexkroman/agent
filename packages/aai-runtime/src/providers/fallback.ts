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
 * The machinery both stages share: walk the members from `start`, adopting the
 * first that opens, reporting each one skipped.
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

/** A fallback STT opener over resolved members, in order. */
export function createFallbackSttOpener(
  members: readonly FallbackMember<SttOpener>[],
  env: ProviderEnv | undefined,
): SttOpener & FailoverAwareOpener<SttOpenOptions, SttSession> {
  const openReporting = async (
    options: SttOpenOptions,
    onFailover: FailoverListener,
  ): Promise<SttSession> => {
    const out = listenerTable<SttEvents>();
    const openMember = (m: FallbackMember<SttOpener>) =>
      m.opener.open({ ...options, apiKey: keyFor(m, env, options.apiKey) });
    let current: SttSession | null = null;
    let index = 0;
    let produced = false;
    let closed = false;
    let subs: Unsubscribe[] = [];

    const adopt = (session: SttSession, at: number): void => {
      current = session;
      index = at;
      subs = [
        session.on("partial", (text, meta) => {
          produced = true;
          out.emit("partial", (fn) => fn(text, meta));
        }),
        session.on("final", (text, meta) => {
          produced = true;
          out.emit("final", (fn) => fn(text, meta));
        }),
        session.on("error", (err) => {
          const next = members[index + 1];
          if (produced || closed || options.signal.aborted || next === undefined) {
            out.emit("error", (fn) => fn(err));
            return;
          }
          onFailover(failoverOf("stt", members[index]?.kind ?? "", next.kind, err));
          void switchFrom(session, index + 1);
        }),
      ];
    };

    const switchFrom = async (failed: SttSession, start: number): Promise<void> => {
      for (const off of subs) off();
      current = null;
      await failed.close().catch(() => undefined);
      try {
        const { session, index: at } = await openFrom(
          members,
          start,
          openMember,
          options.signal,
          onFailover,
          "stt",
        );
        if (closed || options.signal.aborted) await session.close().catch(() => undefined);
        else adopt(session, at);
      } catch (err) {
        if (!closed)
          out.emit("error", (fn) => fn(createSttError("stt_connect_failed", errorMessage(err))));
      }
    };

    const first = await openFrom(members, 0, openMember, options.signal, onFailover, "stt");
    adopt(first.session, first.index);
    const wrapper: SttSession = {
      sendAudio: (pcm) => current?.sendAudio(pcm),
      on: (event, fn) => out.on(event, fn),
      async close() {
        closed = true;
        for (const off of subs) off();
        await current?.close();
      },
    };
    // The optional controls are the ADOPTED member's: a transport reads their
    // presence as "this provider can", so the wrapper claims only what the
    // session it opened with claims, and forwards to whichever member is live.
    if (first.session.updateEndpointing) {
      wrapper.updateEndpointing = (ms) => current?.updateEndpointing?.(ms);
    }
    if (first.session.forceEndOfTurn) {
      wrapper.forceEndOfTurn = () => current?.forceEndOfTurn?.();
    }
    return wrapper;
  };
  return {
    name: `fallback(${members.map((m) => m.kind).join(",")})`,
    open: (options) => openReporting(options, () => undefined),
    openReporting,
  };
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
  const openReporting = async (
    options: TtsOpenOptions,
    onFailover: FailoverListener,
  ): Promise<TtsSession> => {
    const out = listenerTable<TtsEvents>();
    const openMember = (m: FallbackMember<TtsOpener>) =>
      m.opener.open({ ...options, apiKey: keyFor(m, env, options.apiKey) });
    let current: TtsSession | null = null;
    let index = 0;
    let produced = false;
    let closed = false;
    let subs: Unsubscribe[] = [];
    // Everything sent since the session opened, until the first audio: what a
    // member that failed before speaking never got to say.
    const pending: TtsCall[] = [];

    const adopt = (session: TtsSession, at: number): void => {
      current = session;
      index = at;
      subs = [
        session.on("audio", (pcm) => {
          produced = true;
          pending.length = 0;
          out.emit("audio", (fn) => fn(pcm));
        }),
        session.on("words", (words) => out.emit("words", (fn) => fn(words))),
        session.on("done", () => out.emit("done", (fn) => fn())),
        session.on("error", (err) => {
          const next = members[index + 1];
          if (produced || closed || options.signal.aborted || next === undefined) {
            out.emit("error", (fn) => fn(err));
            return;
          }
          onFailover(failoverOf("tts", members[index]?.kind ?? "", next.kind, err));
          void switchFrom(session, index + 1);
        }),
      ];
      for (const call of pending) {
        if (call.method === "sendText") session.sendText(call.text);
        else session.flush();
      }
    };

    const switchFrom = async (failed: TtsSession, start: number): Promise<void> => {
      for (const off of subs) off();
      current = null;
      await failed.close().catch(() => undefined);
      try {
        const { session, index: at } = await openFrom(
          members,
          start,
          openMember,
          options.signal,
          onFailover,
          "tts",
        );
        if (closed || options.signal.aborted) await session.close().catch(() => undefined);
        else adopt(session, at);
      } catch (err) {
        if (!closed)
          out.emit("error", (fn) => fn(createTtsError("tts_connect_failed", errorMessage(err))));
      }
    };

    const first = await openFrom(members, 0, openMember, options.signal, onFailover, "tts");
    adopt(first.session, first.index);
    const record = (call: TtsCall): void => {
      if (!produced) pending.push(call);
    };
    return {
      sendText(text) {
        record({ method: "sendText", text });
        current?.sendText(text);
      },
      flush() {
        record({ method: "flush" });
        current?.flush();
      },
      cancel() {
        // A cancelled turn is not replayed into a successor.
        pending.length = 0;
        current?.cancel();
      },
      on: (event, fn) => out.on(event, fn),
      async close() {
        closed = true;
        for (const off of subs) off();
        await current?.close();
      },
    };
  };
  return {
    name: `fallback(${members.map((m) => m.kind).join(",")})`,
    open: (options) => openReporting(options, () => undefined),
    openReporting,
  };
}
