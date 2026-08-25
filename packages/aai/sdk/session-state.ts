// Copyright 2026 the AAI authors. MIT license.
/**
 * The seam a {@link sessionSlot} reads and writes through, and the one rule
 * every value crossing it obeys.
 *
 * A session's slot values used to live in `ctx.state` — one mutable bag per
 * session, held in a `Map` in the runtime's own heap, and therefore gone the
 * moment the process was. A crash or a redeploy handed a reconnecting caller an
 * agent that remembered the whole conversation and had forgotten its cart,
 * because the client replays history (`aai-ui/session-core.ts`) and there is
 * nothing on the client to replay state from.
 *
 * So a slot writes to a STORE instead, and the store has two backends chosen by
 * whether the app has a database (`host/session-state-store.ts`). Which one is
 * a property of the DEPLOYMENT, never of a slot: a per-slot `persist` flag was
 * the first design and it recreates a failure this repo has already paid for —
 * an in-memory store holds JS objects, so it cannot represent an encoding bug,
 * and every test against a memory-backed slot would pass on shapes Postgres
 * cannot hold.
 *
 * That is what `freezeStorable` (below) is for, and why it runs in BOTH backends.
 * It is the whole reason the memory backend is a valid test double for the
 * Postgres one.
 */

/**
 * One session's slot storage, as a tool's context carries it.
 *
 * Two methods and no index signature, which is the point: it replaced
 * `ctx.state`, a field typed `any` whose entire justification was that the bag
 * it held was dynamic. A slot's value is typed by its own `sessionSlot<T>`,
 * which is stronger than the annotation authors used to be told to write, and
 * there is no longer a bag to cast.
 *
 * **Reach for {@link sessionSlot} rather than this.** It is on the context
 * because a slot lives in a module that has no other way to find the session,
 * not because a tool body should call it.
 *
 * @public
 */
export type SlotStore = {
  /**
   * This session's value for `key`, or `undefined` when the slot has never
   * been written (a fresh session, or one whose stored value was discarded).
   *
   * The returned object is FROZEN — see `freezeStorable` in this module.
   */
  read(key: string): unknown;
  /**
   * Store this session's value for `key`.
   *
   * `durable` is the slot's own declaration. A durable value is checked and
   * frozen here and committed to the backend at the end of the tool call; a
   * virtual one is neither, because the things a virtual slot exists to hold
   * (a provider handle, an open socket) can be neither serialized nor frozen.
   */
  write(key: string, value: unknown, durable: boolean): void;
};

/**
 * Anything that can reach one session's slots.
 *
 * Every {@link SessionSlot} and {@link Dialog} method takes this rather than a
 * full {@link ToolContext}, and the widening is the whole reason a session event
 * handler can maintain state: these two fields are ALL any of them ever read, so
 * requiring the other eight was a statement that slots are a tool-only
 * capability — which stopped being true when {@link SessionEventContext} grew
 * one.
 *
 * Both a `ToolContext` and a {@link SessionEventContext} satisfy it
 * structurally, so no existing call site changed.
 *
 * @public
 */
export type SlotHolder = {
  /** This session's slot storage. */
  readonly slots: SlotStore;
  /**
   * Which session. Not reachable from {@link SlotStore}, which is already scoped
   * to one — a slot needs the id to key its open-draft guard, the check that
   * refuses a `set`/`reset`/`update` issued from inside another `update`'s
   * mutator.
   */
  readonly sessionId: string;
};

/**
 * One slot's contribution to the `agent_state` frame — what
 * {@link SessionSlot.projection} returns and what `agent({ syncState })` takes.
 *
 * It is a FUNCTION carrying the two facts the runtime needs, rather than a
 * plain record, and the callable half is load-bearing at both ends. The server
 * calls it with whatever the store holds; a `client.tsx` calls it with nothing
 * to derive the frame it renders before the first tool call, from the same
 * function — so a field added to the projection reaches the first render
 * instead of being missing until something changes.
 *
 * @public
 */
export interface StateProjection<V = unknown> {
  /** Project a stored value, or the slot's default when there is none. */
  (value?: unknown): V;
  /** The slot key whose value this projects. */
  readonly key: string;
  /** The slot's default, for a session that has not touched it. */
  readonly create: () => unknown;
}

/** Thrown when a durable slot is handed something a database cannot hold. */
export class SlotValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlotValueError";
  }
}

/** What `Object.getPrototypeOf` returns for the two object shapes JSON holds. */
const PLAIN_PROTOTYPES: ReadonlySet<unknown> = new Set([Object.prototype, null]);

/** Describe what was found, for an error that has to be actionable. */
function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return "a bigint";
  if (typeof value === "function") return "a function";
  if (typeof value === "symbol") return "a symbol";
  if (typeof value === "number") return String(value);
  if (value instanceof Map) return "a Map";
  if (value instanceof Set) return "a Set";
  if (value instanceof Date) return "a Date";
  const name = (value as object).constructor?.name;
  return name ? `a ${name} instance` : "a non-plain object";
}

/**
 * Validate that `value` can be stored, and freeze it, in one walk.
 *
 * ## Why this is not `JSON.stringify`
 *
 * Because the values that matter do not throw. `JSON.stringify(new Map())` is
 * `"{}"`, a `Date` becomes a string, `NaN` becomes `null`, and a class instance
 * becomes a bag of its own fields — every one of them a value that round-trips
 * to something ELSE, silently, and only for the deployment that has a database.
 * That is precisely the two-path failure one store with two backends exists to
 * prevent, so the check is structural and runs in the memory backend too.
 *
 * `undefined` as a PROPERTY value is allowed and dropped on the round trip,
 * which is what JSON does and what `exactOptionalPropertyTypes` already makes
 * authors write around. `undefined` inside an ARRAY is refused: it becomes
 * `null`, which changes the element rather than removing the key.
 *
 * ## Why it freezes, and why the type MATCHES the freeze
 *
 * The freeze is the real guarantee, and it is DEEP — this walk calls
 * `Object.freeze` on every array and every nested object it validates.
 * `SessionSlot.get` therefore returns `DeepReadonly<T>` (`sdk/session-slot.ts`).
 *
 * It returned a shallow `Readonly<T>` for a while, on the argument that a deep
 * one would propagate through every domain helper an agent's own modules declare
 * — `orderTotal(cart)`, `incidentSummary(incident)` — for a guarantee this walk
 * already gave at runtime. It does propagate, and the argument was still wrong:
 * a shallow type left the RUNTIME STRICTER THAN THE TYPE, so
 * `game.inventory.push(item)` and `game.flags[key] = true` both compiled and
 * both threw on the first call. Two shipped templates did exactly that, in tools
 * nothing in the repo executed. A type that under-describes a runtime rule does
 * not save the call sites it fails to reach; it just moves the report from
 * compile time to production.
 *
 * The propagation is the price, and it is paid at the helper: a helper that must
 * take a slot read declares `DeepReadonly<T>` (or its own readonly shape), and
 * one that will not is a helper that mutates — which is the finding, not the
 * inconvenience.
 *
 * ES modules are strict, so a mutation of a frozen value is a `TypeError` rather
 * than a write that sticks in memory and vanishes through Postgres. Paid once
 * per WRITE, where the alternative (a walk per read) is the wrong end for a
 * store read far more often than it is written.
 *
 * @throws SlotValueError naming the path, so a failure says which field.
 * @internal
 */
export function freezeStorable<T>(value: T, path: string): T {
  walk(value, path, { ancestors: new Set(), done: new WeakSet() });
  return value;
}

/**
 * The walk's bookkeeping, and it is TWO sets for a reason worth keeping.
 *
 * `ancestors` is the path from the root to the node being visited, so a cycle is
 * a node that is its own ancestor. `done` is every node already validated, so a
 * subtree reachable by more than one path is walked once.
 *
 * A single visited-set cannot do both jobs, and the first draft of this used one:
 * it reported `retail.store.orders.#W2417020.items[0].options is a circular
 * reference` on a seed catalogue that has no cycle at all — the same `options`
 * object is shared by two items, which is a DAG. Aliasing is legal to store; what
 * it does not do is SURVIVE storage, since JSON writes each reference out
 * separately, so a hydrated value holds two equal objects where the live one held
 * one. That matters only to code comparing by identity.
 */
type Walk = { ancestors: Set<object>; done: WeakSet<object> };

function walk(value: unknown, path: string, seen: Walk): void {
  if (value === null) return;
  switch (typeof value) {
    case "boolean":
    case "string":
      return;
    case "number":
      if (Number.isFinite(value)) return;
      throw new SlotValueError(
        `${path} is ${describe(value)}, which JSON stores as null. Use a finite number, or null.`,
      );
    case "object":
      break;
    default:
      throw new SlotValueError(`${path} is ${describe(value)}, which cannot be stored.`);
  }
  const object = value as object;
  // A cycle is the one failure JSON.stringify DOES throw on, and its message
  // names no path — which is the whole difficulty of finding one by hand.
  if (seen.ancestors.has(object)) {
    throw new SlotValueError(`${path} is a circular reference, which cannot be stored.`);
  }
  if (seen.done.has(object)) return;
  seen.ancestors.add(object);
  if (Array.isArray(object)) {
    object.forEach((element, index) => {
      if (element === undefined) {
        throw new SlotValueError(
          `${path}[${index}] is undefined, which JSON stores as null. Filter the list instead.`,
        );
      }
      walk(element, `${path}[${index}]`, seen);
    });
  } else {
    if (!PLAIN_PROTOTYPES.has(Object.getPrototypeOf(object))) {
      throw new SlotValueError(
        `${path} is ${describe(object)}, which does not survive being stored. Hold plain objects, arrays and primitives — a Map becomes {}, a Date becomes a string.`,
      );
    }
    for (const [key, property] of Object.entries(object)) {
      // Absent and present-and-undefined are the same thing to every reader
      // here, and JSON drops the key either way.
      if (property !== undefined) walk(property, `${path}.${key}`, seen);
    }
  }
  seen.ancestors.delete(object);
  seen.done.add(object);
  Object.freeze(object);
}

/**
 * A {@link SlotStore} over a plain map — one session, no backend, no commit.
 *
 * This is what a tool tested in isolation runs against (`createToolContext`),
 * and what a sessionless caller of `executeToolCall` gets. It applies the same
 * check and the same freeze as the real store, deliberately: a template holding
 * a `Map` must fail in its own spec rather than on the first deployment that
 * has a database.
 *
 * @internal
 */
export function createDetachedSlotStore(): SlotStore {
  const values = new Map<string, unknown>();
  return {
    read: (key) => values.get(key),
    write: (key, value, durable) => {
      values.set(key, durable ? freezeStorable(value, key) : value);
    },
  };
}
