// Copyright 2026 the AAI authors. MIT license.
/**
 * The `{ reply } | { routes }` script router `stubGenerate` and `stubDelegate`
 * share: one route for every call, or a table keyed by what tells calls apart
 * (the system prompt, the subagent's name).
 *
 * @module _testing-script
 */

import { isRecord } from "./utils.ts";

/** A script's two shapes, generic over the route each key holds. */
type Script<Route> = {
  readonly reply?: Route | undefined;
  readonly routes?: Readonly<Record<string, Route>> | undefined;
};

/** What {@link scriptRouter} answers. */
export interface ScriptRouter<Reply, Call> {
  /**
   * The reply for `key`, a function route already applied to `call` —
   * `undefined` when a `{ routes }` table has no such key.
   */
  answer(key: string, call: Call): Reply | undefined;
  /** The keys a `{ routes }` table names, for the unrouted-call error. Empty for `{ reply }`. */
  routed: readonly string[];
}

/**
 * Read a script, throwing `misuse` at BIND when it is neither `{ reply }` nor
 * `{ routes }` — a caller with no compiler would otherwise reject every call
 * with a sentence about routes.
 */
/** A computed route: a reply is a string or a plain object, never a function. */
function isComputed<Reply, Call>(
  route: Reply | ((call: Call) => Reply),
): route is (call: Call) => Reply {
  return typeof route === "function";
}

export function scriptRouter<Reply, Call>(
  script: Script<Reply | ((call: Call) => Reply)>,
  misuse: string,
): ScriptRouter<Reply, Call> {
  const given: unknown = script;
  if (!isRecord(given) || "reply" in given === "routes" in given) throw new Error(misuse);
  const routes = "routes" in script ? script.routes : undefined;
  const single = "reply" in script ? script.reply : undefined;
  return {
    routed: Object.keys(routes ?? {}),
    answer: (key, call) => {
      const route = routes ? routes[key] : single;
      return isComputed(route) ? route(call) : route;
    },
  };
}
