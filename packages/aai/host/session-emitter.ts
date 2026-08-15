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
 *
 * eve runs its hooks after a durable write and escalates a thrown handler to a
 * failed turn. Both are wrong here and for the same reason — this is a phone
 * call: a Postgres round trip does not fit inside a turn's latency budget (see
 * `session-event-stream.ts` on what "recorded" means), and an audit hook that
 * throws must not hang up on the caller.
 */

import type { Db } from "../sdk/db.ts";
import type { ClientSink, SessionEvent, SessionEventBody } from "../sdk/protocol.ts";
import type {
  SessionEventContext,
  SessionEventHandler,
  SessionEventHandlers,
} from "../sdk/session-events.ts";
import { errorMessage } from "../sdk/utils.ts";
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
   * `ctx.db`. A THUNK because resolving it is what throws the enablement
   * guidance when storage is off, and an agent with no hooks must not pay that
   * for every event it emits.
   */
  db: () => Db;
};

/**
 * Run the handlers for one event: the typed one, then `"*"`.
 *
 * A throw is caught PER HANDLER, so a broken typed handler does not also
 * suppress the `"*"` one — they are independent declarations and a reader of the
 * log would not expect one to depend on the other. An async handler is not
 * awaited: the caller is mid-turn, and a rejection is caught off the promise for
 * the same reason a throw is caught here.
 */
function runHooks(
  event: SessionEvent,
  handlers: SessionEventHandlers,
  ctx: () => SessionEventContext,
  logger: Logger | undefined,
): void {
  const typed = handlers[event.type];
  const wildcard = handlers["*"];
  if (!(typed || wildcard)) return;
  // Built once for the pair rather than per handler.
  const resolved = ctx();
  for (const handler of [typed, wildcard]) {
    if (!handler) continue;
    try {
      // The handler's own type is narrower than `SessionEvent` for the typed
      // arm, and this loop has widened it back — which is safe in exactly the
      // way the map's key guarantees: `handlers[event.type]` was looked up BY
      // this event's own type, so the handler it yields is declared for it.
      const result = (handler as SessionEventHandler)(event, resolved);
      if (result instanceof Promise) {
        result.catch((err: unknown) => {
          logger?.warn?.("Session event hook failed", {
            type: event.type,
            id: event.meta.id,
            error: errorMessage(err),
          });
        });
      }
    } catch (err: unknown) {
      logger?.warn?.("Session event hook failed", {
        type: event.type,
        id: event.meta.id,
        error: errorMessage(err),
      });
    }
  }
}

/**
 * The hook deps for one agent, or undefined when it declared no handlers.
 *
 * Here rather than at the call site because every part of it is this module's
 * contract — including the one decision that is easy to get wrong: `db` is a
 * THUNK, so an agent with no handlers never resolves a database and one WITHOUT
 * storage still gets its hooks (see `context`).
 *
 * @internal
 */
export function hookDepsFor(opts: {
  handlers: SessionEventHandlers | undefined;
  env: Readonly<Record<string, string>>;
  db: Db | undefined;
  /** Thrown when a handler reads `ctx.db` on an agent that has no storage. */
  storageDisabledMessage: string;
}): SessionEventHookDeps | undefined {
  if (!opts.handlers) return undefined;
  return {
    handlers: opts.handlers,
    env: opts.env,
    db: () => {
      if (!opts.db) throw new Error(opts.storageDisabledMessage);
      return opts.db;
    },
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
  logger?: Logger | undefined;
}): SessionEmitter {
  const { sessionId, client, stream, hooks, logger } = opts;
  const handlers = hooks?.handlers;

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
  const context = (): SessionEventContext => ({
    sessionId,
    env: hooks?.env ?? {},
    get db(): Db {
      // By construction: `handlers` is only set when `hooks` is, and `runHooks`
      // is the only caller.
      return hooks ? hooks.db() : missingHookDeps();
    },
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
    if (handlers) runHooks(event, handlers, context, logger);
    return event;
  }

  return { emit: publish };
}

/**
 * The `db` a hook context reports when the emitter was built without hook deps.
 *
 * Unreachable — `context()` only resolves `db` when `hooks` is set — and a
 * thrower rather than a cast, so a future caller that reaches it gets a named
 * failure instead of `undefined` presenting as a database.
 */
function missingHookDeps(): never {
  throw new Error("Session event hooks were not configured for this session");
}
