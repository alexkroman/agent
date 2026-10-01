// Copyright 2026 the AAI authors. MIT license.
/**
 * The two things every `agent({ routes })` handler that takes input wrote for
 * itself: a way to answer "you asked wrong" (a 400) from deep inside a helper,
 * and the checks at the door — a JSON body of the right shape, a `?client=`.
 *
 * - {@link routeError} / {@link RouteError} — THROW one anywhere under a
 *   handler and the route answers that status with `{ error: message }`,
 *   instead of the 500 a plain throw is. Recognized by a `Symbol.for` brand,
 *   not `instanceof`: the handler runs in the agent bundle's copy of the SDK
 *   and the dispatcher in the host's (see `agent-routes.ts`).
 * - {@link route} — a handler with its body validated by a Standard Schema
 *   (zod, valibot…) and, optionally, `req.clientId` required, both answered
 *   400 with the reason before the handler runs.
 *
 * `route()` answers a `RouteError` itself too, so a handler built with it
 * behaves the same on a runtime that predates the dispatcher recognizing one.
 *
 * @module
 */

import { readBrand, setBrand } from "./_boundary.ts";
import {
  type RouteContext,
  type RouteHandler,
  type RouteRequest,
  routeResponse,
} from "./agent-routes.ts";
import { isRecord } from "./is-record.ts";
import {
  formatSchemaIssues,
  type InferSchemaOutput,
  type StandardSchemaV1,
} from "./standard-schema.ts";

/** A status a route error may answer: 4xx or 5xx. */
function isErrorStatus(status: unknown): status is number {
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599;
}

/**
 * A route's refusal, THROWN: the route answers `status` with
 * `{ error: message }`. Build one with {@link routeError}.
 *
 * @public
 */
export class RouteError extends Error {
  /** The HTTP status the route answers: 4xx or 5xx. */
  readonly status: number;

  /** Throws a `RangeError` for a status that is not 4xx or 5xx. */
  constructor(status: number, message: string) {
    if (!isErrorStatus(status)) {
      throw new RangeError(`RouteError: status must be a 4xx or 5xx code, got ${status}`);
    }
    super(message);
    this.name = "RouteError";
    this.status = status;
    // The registered `routeError` brand, so every copy of this module reads it;
    // non-enumerable, so it never reaches a log line's serialization.
    setBrand(this, "routeError", true);
  }
}

/**
 * A {@link RouteError} to throw from anywhere under a route handler:
 * `throw routeError(400, "name: text up to 80 characters")`. The route answers
 * that status with `{ error: message }` rather than a 500.
 *
 * @example
 * ```ts
 * import { type RouteRequest, routeError } from "@alexkroman1/aai";
 *
 * function appSlug(req: RouteRequest): string {
 *   const slug = req.params.app ?? "";
 *   if (!/^[a-z0-9_-]{1,64}$/.test(slug)) throw routeError(400, "not an app name");
 *   return slug;
 * }
 * ```
 *
 * @public
 */
export function routeError(status: number, message: string): RouteError {
  return new RouteError(status, message);
}

/**
 * `err` as a route answer when it is a {@link RouteError} from any copy of
 * this module, else `undefined` (an ordinary throw: a 500). The status is
 * re-checked rather than trusted, since anyone can mint the brand.
 *
 * @internal
 */
export function readRouteError(err: unknown): { status: number; message: string } | undefined {
  if (!isRecord(err) || readBrand(err, "routeError") !== true) return undefined;
  const { status, message } = err;
  if (!isErrorStatus(status)) return undefined;
  return { status, message: typeof message === "string" ? message : "" };
}

/**
 * The request a {@link route} handler receives: `body` already validated (the
 * schema's OUTPUT), and `clientId` a `string` when `requireClient` is set.
 *
 * @public
 */
export type ValidatedRouteRequest<Body, Client extends boolean> = Omit<
  RouteRequest,
  "body" | "clientId"
> & { body: Body } & (Client extends true ? { clientId: string } : { clientId?: string });

/**
 * What {@link route} takes.
 *
 * @public
 */
export interface RouteDef<
  S extends StandardSchemaV1 = StandardSchemaV1<unknown, unknown>,
  Client extends boolean = false,
> {
  /**
   * A Standard Schema the JSON body must satisfy; the handler gets its output.
   * A refused body (or none) is a 400 naming the issues.
   */
  body?: S;
  /** `true`: a request without a well-formed `?client=` is a 400. */
  requireClient?: Client;
  /** The handler, with what the checks above guarantee typed in. */
  handler: (req: ValidatedRouteRequest<InferSchemaOutput<S>, Client>, ctx: RouteContext) => unknown;
}

/** The sentence a request without `?client=` is refused with. */
const CLIENT_REQUIRED = "?client= is required";

/**
 * A route handler with its checks at the door: `body` validated against a
 * Standard Schema and `?client=` required, each refused with a 400 and the
 * reason. A {@link RouteError} thrown inside answers its own status.
 *
 * @example
 * ```ts
 * import { agent, route } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * export default agent({
 *   name: "Kitchen speaker",
 *   routes: {
 *     "PUT /profile": route({
 *       body: z.object({ name: z.string().max(80) }),
 *       requireClient: true,
 *       handler: async (req) => ({ saved: req.body.name, for: req.clientId }),
 *     }),
 *   },
 * });
 * ```
 *
 * @public
 */
export function route<
  S extends StandardSchemaV1 = StandardSchemaV1<unknown, unknown>,
  Client extends boolean = false,
>(def: RouteDef<S, Client>): RouteHandler {
  return async (req, ctx) => {
    if (def.requireClient === true && req.clientId === undefined) {
      return routeResponse(400, { error: CLIENT_REQUIRED });
    }
    let body: unknown = req.body;
    if (def.body !== undefined) {
      const result = await def.body["~standard"].validate(req.body);
      if (result.issues) {
        return routeResponse(400, {
          error: `Invalid request body: ${formatSchemaIssues(result.issues)}`,
        });
      }
      body = result.value;
    }
    try {
      return await def.handler(
        { ...req, body } as ValidatedRouteRequest<InferSchemaOutput<S>, Client>,
        ctx,
      );
    } catch (err: unknown) {
      const refusal = readRouteError(err);
      if (refusal === undefined) throw err;
      return routeResponse(refusal.status, { error: refusal.message });
    }
  };
}
