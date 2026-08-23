// Copyright 2026 the AAI authors. MIT license.
/**
 * Which keys of an agent's env a SERVER may read.
 *
 * One function, in its own module rather than beside `isHostAllowed` in
 * `host-mode.ts`, because both front doors that build a server need it and
 * neither of them is that module: the guest harness had its own copy of the line,
 * and `createAgentServer` needed the same filter when it turned out to be
 * forwarding no env to `createServer` at all.
 *
 * @module
 */

/**
 * An agent's env as a SERVER may read it: everything except the host-mode gate.
 *
 * `createServer` reads four things out of `env` — `DATABASE_URL` (where a workflow
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
