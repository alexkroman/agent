// Copyright 2026 the AAI authors. MIT license.
/**
 * Which keys of an agent's env a SERVER may read, and what a BLANK one means.
 *
 * One function, in its own module rather than beside `isHostAllowed` in
 * `host-mode.ts`, because both front doors that build a server need it and
 * neither of them is that module: the guest harness had its own copy of the line,
 * and `createAgentServer` needed the same filter when it turned out to be
 * forwarding no env to `createRuntimeServer` at all.
 *
 * @module
 */

import { isBlankSecret } from "./bearer.ts";
import type { Logger } from "./runtime-config.ts";

/**
 * An agent's env as a SERVER may read it: everything except the host-mode gate.
 *
 * `createRuntimeServer` reads four things out of `env` — `DATABASE_URL` (where a workflow
 * upload's record lives), `AAI_WORKFLOW_API_TOKEN` and `AAI_SESSION_EVENTS_TOKEN`
 * (the gates on those two routes), and `AAI_ALLOW_HOST` — and the fourth must not
 * ride along with the first three. A door that serves ONE agent on the operator's
 * credentials is not a door a tenant may turn host mode on inside by setting one
 * secret: `?host=1` lets a caller supply its own agent definition, `/websocket` has
 * no authentication of its own, and the resulting session runs on those
 * credentials with a prompt of the caller's choosing.
 *
 * Omitting the key rather than adding a `hostMode: "off"` option, because
 * `isHostAllowed`'s contract (`host-mode.ts`) is already "no env, no host mode",
 * and this is
 * the caller saying which env it is willing to have read. A new option would be a
 * second way to express one rule.
 *
 * Exported on `@alexkroman1/aai-runtime/internal` because the guest harness makes
 * exactly the same statement about a deployed agent, and it had its own copy of
 * this line — two spellings of one security filter, where a fifth gate variable
 * added later would have to be remembered twice.
 *
 * @internal
 */
export function agentServerEnv(env: Record<string, string>): Record<string, string> {
  const { AAI_ALLOW_HOST: _hostGate, ...rest } = env;
  return rest;
}

/**
 * The bearer a GATE variable configures, or `undefined` — with a blank value
 * ANNOUNCED rather than obeyed.
 *
 * `AAI_WORKFLOW_API_TOKEN` and `AAI_SESSION_EVENTS_TOKEN` are the two keys whose
 * whole job is to require a credential, and both were read straight out of the
 * env. Set but EMPTY, they turned authentication off: `bearerMatches` compared
 * two empty buffers, which `timingSafeEqual` MATCHES, and both routes guarded
 * only `token === undefined`. Measured, `GET /session-events/:id` answered 200
 * with the conversation to a request carrying no `Authorization` header at all.
 * The value is reachable without a shell — `SecretUpdatesSchema` is
 * `z.record(SecretKeySchema, z.string())`, so the studio's Secrets pane accepts
 * an empty one.
 *
 * `bearerMatches` refuses a blank secret on its own now, which makes the
 * comparison safe for every caller (see `isBlankSecret`). What THIS adds is the
 * only thing that layer cannot: a POSTURE and a LOG LINE. Left to the comparison
 * alone, a blank variable means a route that answers 401 to everyone forever,
 * indistinguishable from a wrong token — and for the workflow API it would also
 * 401 `aai workflow` and the studio's runs card, with nothing anywhere saying
 * why. Read as ABSENT, each route falls back to the posture its own doc
 * documents for an unset variable (the workflow API open, the session-event
 * stream 404 with a message naming the variable to set), and the operator gets
 * the sentence below.
 *
 * **Announced, not thrown, and that is the deliberate half.** The repo's
 * boot-refusal precedent is `AAI_GUEST_TOKEN` (`harness.ts`: `if (!token)
 * process.exit(1)`), which is a MANDATORY secret with no safe reading. These two
 * are optional by construction, so they belong with the other precedent —
 * `resolveKey`'s `configured !== ""` in `aai-server/guest-token.ts`, and
 * `requireEnv`'s `!env[k]` — where blank means absent. Throwing here would take
 * a whole agent, voice sessions included, off the air because one optional
 * route's secret got saved blank in a web form; and it would take it off the air
 * BEFORE the bind, so the guest's `/manage` surface — where `aai logs` reads
 * from — would never exist to serve the explanation. `error` rather than `warn`
 * because the operator asked for a closed surface and did not get one.
 *
 * @internal
 */
export function agentGateToken(
  env: Record<string, string> | undefined,
  name: string,
  logger: Logger,
): string | undefined {
  const configured = env?.[name];
  if (configured === undefined) return undefined;
  if (!isBlankSecret(configured)) return configured;
  logger.error(
    `${name} is set but EMPTY, which is not a credential anything can present. ` +
      "Treating it as unset — this route now answers as it does with the variable " +
      "absent. Set it to a real secret, or remove it to choose that default deliberately.",
  );
  return undefined;
}
