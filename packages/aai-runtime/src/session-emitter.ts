// Copyright 2026 the AAI authors. MIT license.
/**
 * One session's emit path — the single place an event becomes a fact.
 *
 * Everything that used to call `client.event(...)` calls {@link SessionEmitter.emit}
 * instead, and that is the whole point: an event now has THREE readers (the
 * retained stream, the connected client, the agent's own hooks) and exactly one
 * writer, so none of them can see a different set of events or a different order.
 *
 * ## The order is fixed, and each step earns its place
 *
 * 1. **Record** — `stream.append` stamps `meta` and assigns the index,
 *    synchronously. First, so nothing downstream can observe an event the log
 *    does not have.
 * 2. **Send** — to the client sink, which decides by event type whether the
 *    frame may overtake held audio. Before hooks, so a slow or throwing hook
 *    cannot delay a caption or a turn boundary on a live call.
 * 3. **Hooks** — the agent's typed handler for this event, then its `"*"`
 *    handler. Last, and non-fatally.
 * 4. **Commit** — only when a hook WROTE a slot: push the `syncState`
 *    projection, then flush the store. Same pair the tool executor runs in its
 *    `finally`, for the same reason — a mutation the UI is not showing is worse
 *    than one it is, and one nothing stored is worse still.
 *
 * ## Hooks may WRITE, and may not SPEAK
 *
 * `SessionEventContext` carries `slots`, so a handler can maintain the session's
 * own state — which is what lets an author stop declaring a TOOL for bookkeeping
 * and instructing the model to call it. It carries no `send`, so the stream stays
 * a record of what happened rather than a second way to drive the turn.
 *
 * Two consequences are wired here rather than documented and hoped for:
 *
 *   * **A write needs a commit**, because nothing else on this path has one.
 *     `slot.update` is synchronous by contract and cannot flush itself, and the
 *     only other commit point in the runtime is the tool executor's — so a hook
 *     write on a session that then runs no tool would never reach the backend.
 *   * **Hooks do not observe themselves.** Committing emits `state.updated`, so
 *     an unguarded handler for it that wrote would re-enter this path forever.
 *     While hooks run — the deferred commit included — nested emits are recorded
 *     and sent to the client but announce nothing. A hook observes the SESSION,
 *     not the other hooks.
 *
 * eve runs its hooks after a durable write and escalates a thrown handler to a
 * failed turn. Both are wrong here and for the same reason — this is a phone
 * call: a Postgres round trip does not fit inside a turn's latency budget (see
 * `session-event-stream.ts` on what "recorded" means), and an audit hook that
 * throws must not hang up on the caller.
 */

import type {
  SessionEventContext,
  SessionEventHandler,
  SessionEventHandlers,
  SlotStore,
} from "@alexkroman1/aai";
import type { ClientSink, SessionEvent, SessionEventBody } from "@alexkroman1/aai/protocol";
import { errorMessage } from "@alexkroman1/aai/utils";
import type { Logger } from "./runtime-config.ts";
import type { SessionEventStream } from "./session-event-stream.ts";

/** The one way to publish a session event. */
export type SessionEmitter = {
  /**
   * Record, send and announce one event. Returns the stamped event, so a caller
   * that needs the envelope (the handshake frame, a test) has it.
   */
  emit(body: SessionEventBody): SessionEvent;
};

/** What the emitter needs to build a handler's context, resolved per session. */
export type SessionEventHookDeps = {
  /** The agent's declared handlers, or undefined when it declared none. */
  handlers?: SessionEventHandlers | undefined;
  /** `ctx.env` — the agent-visible env, never `providerEnv`. */
  env: Readonly<Record<string, string>>;
  /**
   * `ctx.slots` — this session's view of the state store, the same object a tool
   * call's context carries. Not a thunk: it is a plain cache view, so resolving
   * it throws nothing and costs nothing.
   */
  slots: SlotStore;
};

/**
 * A slot store that reports whether anything was written through it.
 *
 * The commit is what a hook write costs, so it is paid only by a batch that
 * actually wrote: the overwhelming majority of events reach a handler that logs
 * a line or bumps a counter, and flushing after each of those would put a
 * backend round trip on the transcript path of a live call.
 *
 * A pass-through wrapper rather than a flag the store itself sets, because
 * `SlotStore` is one view shared with the tool executor — a flag on it could not
 * tell a hook's write from a tool's.
 */
function watchWrites(inner: SlotStore): { slots: SlotStore; writes: () => number } {
  // A COUNT rather than a boolean, and the difference is a real defect: the
  // deferred commit below decides by comparing before against after, and a latch
  // that is already `true` from the synchronous pass compares equal to itself —
  // so a handler that wrote synchronously AND again after an await had its second
  // write silently left uncommitted.
  let writes = 0;
  return {
    slots: {
      read: (key) => inner.read(key),
      write: (key, value, durable) => {
        inner.write(key, value, durable);
        writes += 1;
      },
    },
    writes: () => writes,
  };
}

/**
 * Run the handlers for one event: the typed one, then `"*"`.
 *
 * A throw is caught PER HANDLER, so a broken typed handler does not also
 * suppress the `"*"` one — they are independent declarations and a reader of the
 * log would not expect one to depend on the other. An async handler is not
 * awaited: the caller is mid-turn, and a rejection is caught off the promise for
 * the same reason a throw is caught here.
 *
 * `commit` runs when a handler wrote a slot — synchronously for the handlers
 * that settled synchronously, and again once any pending promise has, since an
 * `async` handler's write lands after the first. Both calls go through `guard`,
 * so the `state.updated` a commit emits does not re-enter the hooks.
 */
function runHooks(
  event: SessionEvent,
  handlers: SessionEventHandlers,
  ctx: (slots: SlotStore) => SessionEventContext,
  deps: { slots: SlotStore; commit: () => void; guard: (run: () => void) => void },
  logger: Logger | undefined,
): void {
  // Widened at the LOOKUP, once. The handler's own type is narrower than
  // `SessionEvent`, and the widening is safe in exactly the way the map's key
  // guarantees: `handlers[event.type]` was looked up BY this event's own type,
  // so the handler it yields is declared for it.
  const typed = handlers[event.type] as SessionEventHandler | undefined;
  const wildcard = handlers["*"];
  if (!(typed || wildcard)) return;
  const watched = watchWrites(deps.slots);
  // Built once for the pair rather than per handler.
  const resolved = ctx(watched.slots);
  const report = (err: unknown): void => {
    logger?.warn?.("Session event hook failed", {
      type: event.type,
      id: event.meta.id,
      error: errorMessage(err),
    });
  };
  const pending: Promise<unknown>[] = [];
  const invoke = (handler: SessionEventHandler | undefined): void => {
    if (!handler) return;
    try {
      const result = handler(event, resolved);
      if (result instanceof Promise) pending.push(result.catch(report));
    } catch (err: unknown) {
      report(err);
    }
  };
  deps.guard(() => {
    // Two calls rather than a loop over a two-element array: this runs per EVENT
    // on a live call, and the array existed only to say "these two, in order".
    invoke(typed);
    invoke(wildcard);
    if (watched.writes() > 0) deps.commit();
  });
  if (pending.length === 0) return;
  // Re-read AFTER the promises settle rather than captured: that is the whole
  // point of the second commit, which exists for the handler that awaits
  // something and then writes. Skipped when nothing further was written — which
  // is why this counts writes rather than latching a flag.
  const before = watched.writes();
  void Promise.all(pending).then(() => {
    if (watched.writes() === before) return;
    deps.guard(() => {
      deps.commit();
    });
  });
}

/**
 * The hook deps for one agent, or undefined when it declared no handlers.
 *
 * Here rather than at the call site because every part of it is this module's
 * contract. It used to carry a `db` THUNK — deferred so an agent with no handlers
 * never resolved a database and one without storage still got its hooks — and that
 * went with `ctx.db`: the platform provides no database, so a hook that persists
 * brings its own client.
 *
 * @internal
 */
export function hookDepsFor(opts: {
  handlers: SessionEventHandlers | undefined;
  env: Readonly<Record<string, string>>;
  slots: SlotStore;
}): SessionEventHookDeps | undefined {
  if (!opts.handlers) return undefined;
  return {
    handlers: opts.handlers,
    env: opts.env,
    slots: opts.slots,
  };
}

/**
 * Build the emit path for one session.
 *
 * @internal
 */
export function createSessionEmitter(opts: {
  sessionId: string;
  client: ClientSink;
  stream: SessionEventStream;
  hooks?: SessionEventHookDeps | undefined;
  /**
   * Publish and store what a hook wrote — the `syncState` push plus the store
   * flush, i.e. the pair the tool executor runs in its own `finally`.
   *
   * Optional because the sandbox tool path holds no state in this process, and
   * absent it a hook's write still lands in the store; what it loses is the
   * commit, so nothing reaches the backend until some later tool call flushes.
   */
  commit?: (() => void) | undefined;
  logger?: Logger | undefined;
}): SessionEmitter {
  const { sessionId, client, stream, hooks, commit, logger } = opts;
  const handlers = hooks?.handlers;

  /**
   * True while hooks (or a commit made on their behalf) are running.
   *
   * The re-entry it stops is real rather than defensive: a commit emits
   * `state.updated`, so a handler for that event which wrote would emit another,
   * forever. See this module's header.
   */
  let announcing = false;
  const guard = (run: () => void): void => {
    const outer = announcing;
    announcing = true;
    try {
      run();
    } finally {
      announcing = outer;
    }
  };

  /**
   * One handler's context.
   *
   * **`db` is a GETTER, so it is resolved only if the handler reads it** — the
   * same shape `ToolContext.db` has, and for a sharper reason here. Resolving is
   * what throws the storage-enablement guidance, so an eagerly-built context made
   * every hook on an agent WITHOUT a database fail before running: the throw was
   * caught, the session survived, and an author's audit handler simply never
   * fired, with one warning per event and nothing naming the real cause. Hooks
   * are useful without storage (a log line, a metric), so that is exactly
   * backwards.
   */
  const context = (slots: SlotStore): SessionEventContext => ({
    sessionId,
    env: hooks?.env ?? {},
    // The WATCHED view rather than `hooks.slots`, so the commit is paid by a
    // batch that wrote and by no other — see `watchWrites`.
    slots,
  });

  function publish(body: SessionEventBody): SessionEvent {
    const event = stream.append(sessionId, body);
    // Sends can throw on a dying socket, and an emit is called from transport
    // event dispatch with no other try/catch above it — so a failed send must
    // not take the process down, and must not skip the hooks either: the event
    // happened whether or not the client heard about it.
    try {
      client.event(event);
    } catch (err: unknown) {
      logger?.warn?.("Session event not delivered", {
        sessionId,
        type: event.type,
        error: errorMessage(err),
      });
    }
    // `announcing` is the re-entry guard: an event emitted BY a hook, or by the
    // commit that follows one, is recorded and sent like any other and announces
    // nothing.
    if (handlers && hooks && !announcing) {
      runHooks(
        event,
        handlers,
        context,
        { slots: hooks.slots, commit: () => commit?.(), guard },
        logger,
      );
    }
    return event;
  }

  return { emit: publish };
}
