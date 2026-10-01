// Copyright 2026 the AAI authors. MIT license.
/**
 * WHO an eval session is: the client, the reported phone number and the placed
 * call a real connection would have carried, recorded where a real connection
 * records them.
 *
 * The runtime learns all three before a session exists — the socket's
 * `?client=` and `?phone=`, a carrier `start` frame's call — and records them
 * under the session id (`../session/ws-handler.ts`, `telephony-server.ts`). Everything
 * downstream reads them back from there: `sessionClientId(ctx)` and friends in
 * a tool, `sessionContext`'s `clientId` and `call`, `onSessionEnd`, the client
 * binding. So the eval records them at the same point and through the same
 * recorder, and nothing downstream can tell the difference — which is the
 * whole claim. The alternative a downstream suite had to write, wrapping
 * `sessionContext` to hand it a fake `call`, reaches the hook and nothing else:
 * `sessionCall(ctx)` in a tool and `onSessionEnd`'s `call` still answered
 * `undefined`.
 *
 * {@link observeSessionContext} is the other half: the greeting wait needs to
 * know what the session will open with, and the only honest way to learn it
 * without calling the app's hook twice (a calling agent's hook CLAIMS the call
 * row — a second call would find it claimed) is to watch the one call the
 * runtime makes.
 *
 * @module
 */

import type { AgentDef, SessionCall } from "@alexkroman1/aai";
import { normalizeE164, recordSessionIdentity } from "@alexkroman1/aai/host-internal";
import { answeredGreeting } from "../session/index.ts";

/** The three identity fields of `EvalSessionOptions`. */
export type EvalSessionIdentity = {
  readonly clientId?: string;
  readonly phone?: string;
  readonly call?: SessionCall;
};

/**
 * Check what can be checked before a runtime is built: a phone number that is
 * not E.164 is the AUTHOR's typo, so it throws rather than being dropped the
 * way the socket drops a stranger's.
 *
 * @returns The identity to record, its phone number normalized to E.164.
 */
export function checkedIdentity(identity: EvalSessionIdentity): EvalSessionIdentity {
  if (identity.clientId !== undefined && identity.clientId.trim() === "") {
    throw new Error("eval session: `clientId` is empty — omit it for a session with no client");
  }
  if (identity.phone === undefined) return identity;
  const phone = normalizeE164(identity.phone);
  if (phone === undefined) {
    throw new Error(
      `eval session: \`phone\` ${JSON.stringify(identity.phone)} is not an E.164 number ` +
        '(a "+", the country code, then the number — "+15035550100"). The socket would drop ' +
        "it silently; an eval refuses, because the case would measure an agent with no number.",
    );
  }
  return { ...identity, phone };
}

/**
 * Record `identity` under `sessionId` — the recorder a socket and a carrier
 * stream call, called at the same point: after the id is decided, before the
 * session is built.
 */
export function recordIdentity(sessionId: string, identity: EvalSessionIdentity): void {
  const { clientId, phone, call } = identity;
  recordSessionIdentity(sessionId, { clientId, phone, call });
}

/** An agent whose `sessionContext` answer is watched, and what it said. */
export type ObservedSessionContext = {
  readonly agent: AgentDef;
  /**
   * What the session will open with, once `start()` settled: the hook's
   * answered greeting when it gave one, else the agent's own. `""` for none.
   */
  greeting(): string;
};

/**
 * `agent` with its `sessionContext` WATCHED — called exactly once, by the
 * runtime, with the runtime's own arguments, its answer handed back untouched.
 *
 * Only the greeting is read off the answer, by the session's own rule
 * (`answeredGreeting`). A hook that rejects, throws or answers nothing leaves
 * the agent's greeting in force, as the session does. A hook that outlives the
 * runtime's deadline is the one approximation: its late answer is recorded
 * here and ignored there. That costs at most one greeting wait, never a wrong
 * transcript, since the wait only decides WHEN a case's first line is said.
 */
export function observeSessionContext(agent: AgentDef): ObservedSessionContext {
  const hook = agent.sessionContext;
  let answered: string | undefined;
  const fallback = agent.greeting ?? "";
  if (hook === undefined) return { agent, greeting: () => fallback };
  return {
    agent: {
      ...agent,
      sessionContext: async (args) => {
        const answer = await hook(args);
        answered = answeredGreeting(answer);
        return answer;
      },
    },
    greeting: () => answered ?? fallback,
  };
}
