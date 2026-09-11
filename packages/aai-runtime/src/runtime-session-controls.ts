// Copyright 2026 the AAI authors. MIT license.
/**
 * Everything ONE session is wired with before its transport exists.
 *
 * Four things, and they are one module because they are built in one order and
 * for one reason — a session has to be observable and controllable before
 * anything can run a turn through it:
 *
 * - the **emitter**, the session's single publishing path (retained stream →
 *   client → the agent's own `events` hooks);
 * - the **dialogs**, which observe that stream, arm their per-state deadlines
 *   and address the prompt's per-turn suffix;
 * - the **usage meter**, what the session has spent;
 * - the **guardrails**, what the session may say.
 *
 * The last two are refused for an s2s agent at config time
 * (`assertSamplingScope`, `assertGuardrailScope`), so neither is built
 * conditionally: such a session gets a meter with no budget on it and an empty
 * guardrail set, which is exactly what its declarations say. The meter is still
 * REAL — every tool call carries it, so an s2s agent's `ctx.generate` and
 * `ctx.delegate` are counted; what s2s cannot feed it is the conversational
 * loop's own tokens (`usage-meter.ts` argues that).
 *
 * Split out of `runtime.ts` at the source-length cap. The ORDER is the reason
 * it is one function rather than four exports — the emitter needs the dialogs'
 * observer, the dialogs need the prompt, and the controls need the emitter, so
 * a caller assembling them by hand has three chances to get it wrong.
 *
 * @module
 */

import type { AgentDef, AgentSessionContext } from "@alexkroman1/aai";
import type { ClientSink } from "@alexkroman1/aai/protocol";
import { errorMessage, omitUndefined } from "@alexkroman1/aai/utils";
import type { Logger } from "./runtime-config.ts";
import { openSessionDialogs, type SessionDialogs } from "./runtime-dialogs.ts";
import type { RuntimeSessionState } from "./runtime-session-state.ts";
import type { SystemPromptResolver } from "./runtime-system-prompt.ts";
import { createSessionEmitter, hookDepsFor, type SessionEmitter } from "./session-emitter.ts";
import { createTurnGuardrails, type TurnGuardrails } from "./transports/pipeline-guardrails.ts";
import type { Transport } from "./transports/types.ts";
import type { TwoTierSession } from "./two-tier/session.ts";
import type { TwoTierOpenArgs } from "./two-tier/wire.ts";
import { createUsageMeter, type UsageMeter } from "./usage-meter.ts";

/** What one session is wired with — see this module's header. @internal */
export interface SessionWiring {
  dialogs: SessionDialogs;
  emitter: SessionEmitter;
  usage: UsageMeter;
  guardrails: TurnGuardrails;
  /**
   * The fast/slow bridge, for an agent that declared `twoTier`.
   *
   * Absent otherwise, and the caller's only obligation is to `stop()` it when
   * the session releases — an in-flight slow run outlives the turn by design,
   * so nothing else ends it.
   */
  twoTier?: TwoTierSession | undefined;
}

/** Build one session's observation and control wiring, in order. @internal */
export function openSessionWiring(deps: {
  agent: AgentDef;
  env: Readonly<Record<string, string>>;
  sessionId: string;
  client: ClientSink;
  state: RuntimeSessionState;
  prompt: SystemPromptResolver;
  limits: { totalTokens?: number | undefined } | undefined;
  transport: () => Transport;
  logger: Logger;
  commitSessionState?: ((sessionId: string) => Promise<void> | void) | undefined;
  /**
   * Open the session's fast/slow bridge, when the agent declared one.
   *
   * A THUNK supplied by the caller rather than the config, because the bridge
   * needs the session's usage meter and its transport — both built here — and
   * the slow tier's model and tool executor, which are the runtime's. Absent
   * for every agent that declares no `twoTier`, which is what makes the whole
   * feature allocate nothing by default.
   */
  openTwoTier?: ((args: TwoTierOpenArgs) => TwoTierSession) | undefined;
}): SessionWiring {
  const { agent, env, sessionId, state, logger } = deps;
  // ONE view of this session's slots, shared by the hooks, the dialogs and the
  // author functions below: a resolver and a guardrail reading two views of one
  // session would be reading two caches of one value.
  const slots = state.store.viewFor(sessionId);
  const hooks = hookDepsFor({ handlers: agent.events, env, slots });
  // Fire-and-forget: `commitSessionState` never rejects, and the emit path is
  // synchronous — a hook's write must not put a backend round trip in front of
  // the next frame on a live call.
  const commit = deps.commitSessionState
    ? (): void => void deps.commitSessionState?.(sessionId)
    : undefined;
  // What a per-session author FUNCTION is handed — a `systemPrompt` resolver
  // and both guardrail lists. See `AgentSessionContext`.
  const context: AgentSessionContext = { sessionId, env, slots };
  // Every session event is offered to each declared dialog, its per-state
  // deadline is armed, and the active instructions become the prompt's per-turn
  // suffix. Inert for an agent that declares none — see `runtime-dialogs.ts`.
  const dialogs = openSessionDialogs(agent.dialogs, sessionId, {
    prompt: deps.prompt.forSession(context),
    slots,
    transport: deps.transport,
    logger,
    ...omitUndefined({ commit }),
  });
  // The one way this session publishes an event: recorded into the retained
  // stream, sent to the client, then announced to the agent's own hooks. Built
  // BEFORE the transport callbacks, because two of them emit directly.
  // Late-bound, because the bridge needs the usage meter and the meter needs
  // the emitter. Two observers of one stream, composed here rather than by
  // widening `createSessionEmitter` to take a list: the emitter's contract is
  // one `observe`, and the session's own state — which is what both of these
  // are — is this module's business to assemble.
  let twoTier: TwoTierSession | undefined;
  const emitter = createSessionEmitter({
    sessionId,
    client: deps.client,
    stream: state.stream,
    // Dialogs FIRST, keeping the order `runtime-dialogs.ts` argues for (a
    // dialog is part of the session's state and moves before any observer sees
    // the effect). The bridge is the second observer for the same reason: its
    // digest is state, and `agent({ events })` hooks run after both.
    observe: (event) => {
      dialogs.observe(event);
      twoTier?.observe(event);
    },
    logger,
    ...omitUndefined({ hooks, commit }),
  });
  // Does anything READ `usage.updated`? Announcing is not free: the meter
  // records once per model STEP — every step of every turn, plus every
  // `ctx.generate` and every step of every `ctx.delegate` — so a default
  // `maxSteps: 10` tool turn mints up to eleven ULIDs, appends eleven entries
  // to the retained stream (against its `MAX_SESSION_EVENTS` budget), and sends
  // eleven client frames competing with audio, on the path this repo measures
  // time-to-first-token on. The event is cumulative and last-write-wins, so a
  // reader that arrives late still sees the true total and per-step granularity
  // buys nobody anything. Wired therefore only for the two readers the SDK
  // documents — a declared budget, and an `events` handler for this type or
  // `"*"` — which is the treatment `text-agent-events.ts` already gives it via
  // `NO_EVENTS.usage`. `record()` stays unconditional: it is in-memory, free,
  // and what `usageLimits` is enforced from.
  const readsUsage =
    deps.limits !== undefined ||
    agent.events?.["usage.updated"] !== undefined ||
    agent.events?.["*"] !== undefined;
  const usage = createUsageMeter({
    limits: deps.limits,
    onUpdate: readsUsage
      ? (snapshot) => emitter.emit({ type: "usage.updated", ...snapshot })
      : undefined,
  });
  // Now that both exist. The digest's prompt section goes on the SAME
  // `SessionSystemPrompt` the dialogs hold, under its own key — an unkeyed
  // install would have deleted theirs (see `SessionSystemPrompt.setSuffix`).
  twoTier = deps.openTwoTier?.({
    sessionId,
    usage,
    transport: deps.transport,
    instructions: () => deps.prompt.base(),
  });
  if (twoTier) dialogs.prompt.setSuffix("two-tier", twoTier.promptSection);
  return {
    dialogs,
    emitter,
    usage,
    ...omitUndefined({ twoTier }),
    guardrails: createTurnGuardrails({
      inputGuardrails: agent.inputGuardrails,
      outputGuardrails: agent.outputGuardrails,
      context,
      onError: (direction, err) =>
        emitter.emit({
          type: "error.reported",
          code: "internal",
          message: `An ${direction} guardrail threw and was skipped: ${errorMessage(err)}`,
          // NON-fatal: the text went through, and taking the call down on top
          // of a check that could not decide helps nobody.
          fatal: false,
        }),
      onBlocked: (direction, replacement) =>
        emitter.emit({ type: "guardrail.blocked", direction, replacement }),
    }),
  };
}
