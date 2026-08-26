// Copyright 2026 the AAI authors. MIT license.
/**
 * Cross-replica change notifications for the platform's Postgres rows.
 *
 * Watchable streams, all **signals rather than payloads** — a handler
 * re-reads the row it cares about instead of trusting anything that rode on
 * the event. That keeps the row (the source of truth) authoritative: a lost
 * or duplicated event can only delay or repeat a read, never deliver stale
 * data, and Supabase Realtime's payload size cap never matters.
 *
 * - `watchAgents` — the agents table changed (a deploy bumped `version`, or
 *   a delete removed the row). This stream is THE mover of resident
 *   sandboxes: mutation handlers only write the row, and
 *   `watchAgentInvalidation` (sandbox-resolve.ts) retires/terminates
 *   residents on every replica, the writer's included.
 * - `watchWorkspace` — one studio project's workspace row changed. The
 *   studio's SSE route uses it to push preview/file state to the browser,
 *   which replaced the client-side polling loop entirely.
 * - `watchChat` — one project's persisted chat row changed (the guest's
 *   end-of-turn `studio/persist-chat`). Rides the same SSE route so other
 *   tabs/devices see settled turns without re-opening the project.
 * - `watchScopeProjects` — any workspace row in a caller's scope changed
 *   (create/delete/edit). Feeds the scope-level SSE stream behind the home
 *   sidebar's live project list.
 *
 * Two implementations, mirroring every other platform store: Supabase
 * Realtime `postgres_changes` in production (realtime-events.ts) and the
 * in-process emitter below for dev/tests, paired with the memory stores via
 * the decorators so a write and its notification cannot drift.
 */

import type { AgentRows } from "./agent-store.ts";
import type { ChatStore } from "./chat-store.ts";
import type { WorkspaceStore } from "./workspace-store.ts";

/** Unsubscribe handle returned by every watch. Idempotent. */
export type Unwatch = () => void;

/**
 * A change handler. Returning a promise is allowed and MEANINGFUL: nothing in
 * production awaits it (a database change stream has no caller to report back
 * to), but the memory emitter below collects it, which is what makes
 * {@link MemoryPlatformEvents.settled} able to say when a notification has
 * finished being handled.
 *
 * `unknown` rather than `void | Promise<void>` so the return stays as
 * permissive as the bare `void` it replaced — TS special-cases a `void`
 * return to accept any value, but a UNION containing it does not, which
 * rejects every `(slug) => seen.push(slug)` shorthand in the specs.
 */
export type Watcher<A extends unknown[] = []> = (...args: A) => unknown;

export type PlatformEvents = {
  /**
   * Fires when ANY agents row changes (deploy, delete). The handler gets the
   * slug only — re-read the row's version to learn what happened.
   *
   * `onResync` fires when the stream (re)joins, and carries NO slug because a
   * join is not about one row: it says "delivery just started, so anything
   * that changed before now reached nobody." A handler answers it by
   * re-checking everything it holds.
   *
   * It is separate rather than a nullable slug on `onChange` so that a
   * consumer which does not handle resync says so by omission at the call
   * site, instead of silently mishandling a sentinel it never checked for.
   */
  watchAgents(onChange: Watcher<[slug: string]>, onResync?: Watcher): Unwatch;
  /**
   * Fires when one project's workspace row changes. Signal only — the
   * handler re-reads the workspace.
   */
  watchWorkspace(scope: string, project: string, onChange: Watcher): Unwatch;
  /** Fires when one project's persisted chat row changes. Signal only. */
  watchChat(scope: string, project: string, onChange: Watcher): Unwatch;
  /** Fires when any workspace row in `scope` changes. Signal only. */
  watchScopeProjects(scope: string, onChange: Watcher): Unwatch;
  /**
   * Whether change delivery is actually working — see
   * {@link PlatformEventsHealth}.
   *
   * Required rather than optional, deliberately: an implementation that
   * cannot answer this should have to say so (the memory emitter returns
   * "nothing stalled", which is true — it delivers in-process), rather than
   * omit the method and have every reader treat absent as healthy.
   */
  health(): PlatformEventsHealth;
  /** Tear down the underlying connection (production: the Realtime socket). */
  close(): Promise<void>;
};

/**
 * A snapshot of the change streams' delivery health.
 *
 * This exists because a subscription that never joins is the platform's most
 * expensive SILENT failure, and it has been hit twice. Filter columns are
 * validated against the subscriber's claimed role, so an `anon`-authority
 * key (or a missing grant) fails every filtered subscribe server-side with
 * `invalid column for filter` — and realtime-js retries the join forever.
 * The service boots healthy, `/health` answers 200, every request succeeds,
 * and the platform merely stops invalidating resident sandboxes on redeploy
 * and stops pushing studio SSE. The only trace was one `platform.realtime` warn per
 * retry, in a log nobody reads until something else goes wrong.
 *
 * `assertServiceRoleKey` closes the two KNOWN causes at boot. This closes the
 * class: whatever the reason, a channel that has been trying to join for
 * longer than the budget is reported.
 */
export type PlatformEventsHealth = {
  /** Channels currently open — subscribed or still trying. */
  channels: number;
  /**
   * Topics that are DOWN and have been for longer than the join budget —
   * whether they never acked a join or joined and then dropped. Non-empty means
   * changes are NOT being delivered on those channels, however healthy
   * everything else looks.
   *
   * The second half of that used to be missing, and it is the worse case: a
   * channel that joined once was treated as permanently healthy, so a socket
   * that dropped and never came back was invisible here (see `ChannelState` in
   * realtime-events.ts).
   */
  stalled: string[];
};

export type MemoryPlatformEvents = {
  events: PlatformEvents;
  /** Notify agents watchers — wired into the memory agent rows' writes. */
  emitAgent(slug: string): void;
  /**
   * Fire the agents stream's REJOIN signal. Nothing in this emitter calls it
   * on its own — an in-process dispatch has no socket to lose and no join gap
   * to cover — so it exists as the driver for the one thing that does:
   * `watchAgentInvalidation`'s resync path, which production only ever reaches
   * through a Realtime reconnect that no unit test can stage.
   */
  emitAgentResync(): void;
  /**
   * Notify one project's workspace watchers (and its scope's project-list
   * watchers) — wired into memory-store writes.
   */
  emitWorkspace(scope: string, project: string): void;
  /** Notify one project's chat watchers — wired into memory chat writes. */
  emitChat(scope: string, project: string): void;
  /**
   * Resolve once every emitted notification has been DELIVERED and every
   * handler it ran has settled — handlers that emit again included.
   *
   * This exists because an emit is fire-and-forget in both directions: the
   * dispatch is deferred a microtask, and a handler like
   * `watchAgentInvalidation` then does async work (row re-read, slot
   * retirement, a replacement boot) that nothing returns to a caller. Tests
   * had no signal to wait on, so three of them hand-rolled
   * `for (let i = 0; i < N; i++) await Promise.resolve()` — with N=5 in one
   * file and N=20 in two others, which is the tell: nobody knew the number,
   * they raised it until it passed. That is silent when it goes wrong. One
   * more `await` in the handover chain and the spin finishes early, so the
   * assertions run against half-applied state and either flake or, worse,
   * pass while testing nothing.
   *
   * Emitters and rejections are deliberately not surfaced here: a handler's
   * failure is its own business (they all log and swallow), and `settled`
   * answering "the work is over" must not itself become a rejection nobody
   * awaited.
   *
   * Because it really waits, it can DEADLOCK where the spin loop could not:
   * a caller holding a resource the handler needs — `watchAgentInvalidation`
   * queues on the slug lock — must release it first, then settle. The spin
   * loop returned before the handler had run at all, so it never noticed.
   */
  settled(): Promise<void>;
};

/** Hands a dispatch to the emitter's in-flight tracker. */
type TrackDispatch = (dispatch: () => Promise<void>) => void;

/**
 * Composite key for one project within one scope. The separator is NUL because
 * neither a scope nor a project name can contain one, so no pair can forge
 * another's key.
 *
 * It MUST stay the `\u0000` escape rather than a literal NUL byte in the
 * source: one control byte makes the whole file binary to every text tool.
 * `grep -rn watchWorkspace packages` printed "binary file matches" instead of
 * the lines, `git diff` showed "Binary files differ" for every edit, and
 * GitHub declined to render the blob — all for a file that is otherwise plain
 * TypeScript. Same value at runtime, legible at rest.
 *
 * Exported because it is the ONE spelling of this key repo-wide, and the
 * argument above is only as good as its uniformity: a second copy using a
 * printable separator re-opens the collision this closes, invisibly, for as
 * long as the two grammars happen to exclude that character too. Both other
 * copies delegate here — `realtime-events.ts`, whose Realtime channel keys
 * used a SPACE, and `aai-studio-server/studio-workspace.ts` (the session
 * broker's map, the preview coalescer, the workspace mutation lock).
 */
export const projectKey = (scope: string, project: string) => `${scope}\u0000${project}`;

/**
 * The inverse of {@link projectKey}: `[scope, project]`.
 *
 * Exists so a consumer that has to READ a composite back (the memory stores'
 * `list`) does it by splitting on the one separator rather than by prefix-
 * matching, which is the operation that leaked across scopes while the memory
 * workspace store spelled its key with a `/`. A string with no separator —
 * which `projectKey` cannot produce — reads as an empty scope, so a caller
 * comparing a real scope never matches one.
 */
export function splitProjectKey(key: string): [scope: string, project: string] {
  const at = key.indexOf("\u0000");
  return at === -1 ? ["", key] : [key.slice(0, at), key.slice(at + 1)];
}

/** A keyed set of watchers with add/remove/fire — the emitter's one shape. */
function createWatcherMap<A extends unknown[]>(track: TrackDispatch) {
  const watchers = new Map<string, Set<Watcher<A>>>();
  return {
    add(key: string, watcher: Watcher<A>): Unwatch {
      let set = watchers.get(key);
      if (!set) {
        set = new Set();
        watchers.set(key, set);
      }
      set.add(watcher);
      return () => {
        set.delete(watcher);
        if (set.size === 0) watchers.delete(key);
      };
    },
    fire(key: string, ...args: A): void {
      const set = watchers.get(key);
      if (!set) return;
      track(async () => {
        // Deferred a microtask so a watcher's re-read never observes the store
        // mid-write; the set is read after the wait, so a watcher removed in
        // between is still skipped.
        await Promise.resolve();
        await Promise.all([...set].map((watcher) => watcher(...args)));
      });
    },
  };
}

/**
 * In-process events for dev and tests. Emission is deferred a microtask so a
 * watcher's re-read never observes the store mid-write; see
 * {@link MemoryPlatformEvents.settled} for how a caller waits one out.
 */
export function createMemoryPlatformEvents(): MemoryPlatformEvents {
  const inFlight = new Set<Promise<void>>();

  const track: TrackDispatch = (dispatch) => {
    // Neutralized: a handler's rejection is its own to log, and `settled`
    // must not turn one into a rejection its caller never asked for.
    const work = dispatch().then(
      () => undefined,
      () => undefined,
    );
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  };

  const workspaceWatchers = createWatcherMap<[]>(track);
  const chatWatchers = createWatcherMap<[]>(track);
  const scopeWatchers = createWatcherMap<[]>(track);
  // The agents stream is not keyed — there is one, fleet-wide — so both of its
  // watcher sets sit under a constant key. They go through the same map as the
  // keyed streams anyway, because the DISPATCH is the part worth having once:
  // the microtask deferral and the `track` that makes `settled()` able to wait
  // an emit out were written out per emitter before, so a third emitter (the
  // resync) had to remember both.
  const AGENTS = "agents";
  const agentWatchers = createWatcherMap<[slug: string]>(track);
  const agentResyncWatchers = createWatcherMap<[]>(track);

  return {
    events: {
      watchAgents(onChange, onResync) {
        const unwatch = agentWatchers.add(AGENTS, onChange);
        const unwatchResync = onResync ? agentResyncWatchers.add(AGENTS, onResync) : undefined;
        return () => {
          unwatch();
          unwatchResync?.();
        };
      },
      watchWorkspace(scope, project, onChange) {
        return workspaceWatchers.add(projectKey(scope, project), onChange);
      },
      watchChat(scope, project, onChange) {
        return chatWatchers.add(projectKey(scope, project), onChange);
      },
      watchScopeProjects(scope, onChange) {
        return scopeWatchers.add(scope, onChange);
      },
      // Nothing to stall: dispatch is a microtask in this very process, so
      // there is no join to fail and no socket to lose. Reporting zero
      // channels rather than inventing a count keeps the number honest — it
      // means "no Realtime channels", not "no watchers".
      health: () => ({ channels: 0, stalled: [] }),
      close: () => Promise.resolve(),
    },
    emitAgent(slug) {
      agentWatchers.fire(AGENTS, slug);
    },
    emitAgentResync() {
      // Fired through the same map, so `settled()` covers a resync's handlers
      // too — the resync handler does strictly MORE async work than a change
      // handler (one reconcile per resident, not one), so a test that could not
      // wait it out would be the worst-placed one to hand-roll a microtask spin
      // for.
      agentResyncWatchers.fire(AGENTS);
    },
    emitWorkspace(scope, project) {
      workspaceWatchers.fire(projectKey(scope, project));
      // A workspace write is also a scope-level project-list signal (the
      // list re-read decides whether membership actually changed).
      scopeWatchers.fire(scope);
    },
    emitChat(scope, project) {
      chatWatchers.fire(projectKey(scope, project));
    },
    async settled() {
      // A handler may emit again (a delete cascades), so drain until quiescent
      // rather than awaiting one generation of dispatches.
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
  };
}

/**
 * Memory agent rows that notify watchers on every write — the dev-side
 * equivalent of the Postgres tables' `postgres_changes` stream. Production
 * never wraps: the database itself is the emitter there, and a local echo
 * would double-fire the writing replica.
 */
export function withAgentEvents(rows: AgentRows, emit: (slug: string) => void): AgentRows {
  return {
    ...rows,
    async put(record) {
      await rows.put(record);
      emit(record.slug);
    },
    async delete(slug) {
      await rows.delete(slug);
      emit(slug);
    },
    // EVERY mutator, for the reason `withWorkspaceEvents` states below: a
    // version bump nobody hears about is a resident sandbox left on the
    // environment it was spawned with, which is the whole point of the bump.
    async touch(slug) {
      const bumped = await rows.touch(slug);
      if (bumped) emit(slug);
      return bumped;
    },
  };
}

/** Memory workspace store that notifies watchers on every write. See above. */
export function withWorkspaceEvents(
  store: WorkspaceStore,
  emit: (scope: string, project: string) => void,
): WorkspaceStore {
  return {
    ...store,
    // EVERY mutator has to be here, `patch` included. Production wraps
    // nothing — the row's own UPDATE is what Realtime streams — so a mutator
    // missing from this list is invisible in production and silent in dev:
    // the write lands, the version bumps, and no watcher ever hears about it.
    // `patch` is the metadata stamp (`stampWorkspaceMeta`), i.e. the ONLY
    // writer of `previewSlug`/`previewHash`/`previewError`,
    // `deployedSlug`/`deployedHash`, and `databaseEnabled` — so while it was
    // missing, a preview deploy landing under `pnpm dev:aai-server` pushed no
    // `project` frame and the Preview pane sat on its "Starting your
    // preview" screen until the page was reloaded. There is no polling loop
    // behind these streams to cover for a dropped signal.
    async patch(scope, project, workspacePatch) {
      const record = await store.patch(scope, project, workspacePatch);
      // Null means there was no row to patch: nothing changed, so there is
      // nothing to announce.
      if (record) emit(scope, project);
      return record;
    },
    async put(scope, project, doc, expectedVersion) {
      const version = await store.put(scope, project, doc, expectedVersion);
      emit(scope, project);
      return version;
    },
    async delete(scope, project) {
      await store.delete(scope, project);
      emit(scope, project);
    },
  };
}

/** Memory chat store that notifies watchers on every write. See above. */
export function withChatEvents(
  store: ChatStore,
  emit: (scope: string, project: string) => void,
): ChatStore {
  return {
    ...store,
    async putChat(scope, project, messages) {
      await store.putChat(scope, project, messages);
      emit(scope, project);
    },
    async deleteChat(scope, project) {
      await store.deleteChat(scope, project);
      emit(scope, project);
    },
  };
}
