// Copyright 2026 the AAI authors. MIT license.
/**
 * Epoch-1 example: `aai:agent`. An agent as it was authored when a session event
 * handler was OBSERVE-ONLY — {@link SessionEventContext} carried `sessionId`,
 * `env` and `db`, and nothing else.
 *
 * FROZEN, and a PROMISE rather than a decoration: epoch 1 is retained as
 * supported, so `pnpm typecheck` compiling this file is the evidence that an
 * `agent.ts` written at that epoch still compiles. An error here IS the finding
 * — do not edit it to follow a change in the API. That is what a new epoch is
 * for.
 *
 * Epoch 2 added `slots` to that context, so a handler can maintain the session's
 * own state instead of an author declaring a TOOL for bookkeeping and
 * instructing the model to call it. Adding a field is why every handler below is
 * untouched — which is the claim a retained epoch makes. What did NOT change is
 * the half that matters: there is still no `send`, so nothing here can decide
 * what the agent says.
 *
 * The imports are relative source paths for the reason `state/v1.ts` gives.
 */

import type {
  SessionEventContext,
  SessionEventHandler,
  SessionEventHandlers,
  SessionEventType,
} from "../../../index.ts";
import { agent, workflowApp } from "../../../index.ts";

/** The event names a project audits, written down as the published union. */
const AUDITED: readonly SessionEventType[] = ["tool.called", "error.reported"];

/** A handler as a standalone value, typed by the published alias. */
const auditOne: SessionEventHandler = (event, ctx: SessionEventContext) =>
  void `${ctx.sessionId} ${ctx.env.REGION ?? ""} ${event.type}`;

/**
 * The map, declared apart from the agent — the three fields a handler could
 * reach at epoch 1, and the typed parameter the mapped half buys.
 */
const events: SessionEventHandlers = {
  "tool.called": (event, ctx) => {
    // Typed by the key: `toolName` and `args` need no narrowing here.
    void ctx.db;
    return `${event.toolName}:${Object.keys(event.args).length}`;
  },
  "user-transcript.committed": (event) => event.text.length,
  "*": auditOne,
};

/** A voice agent, with the pipeline defaults and the tuning fields inline. */
export const voice = agent({
  name: "Claims Desk",
  greeting: "Claims desk — what's your policy number?",
  systemPrompt: "Verify the caller, then quote.",
  voice: "paul",
  maxSteps: 6,
  toolChoice: "auto",
  requiredEnv: ["ASSEMBLYAI_API_KEY"],
  events,
});

/**
 * A static agent, which opens no session and so takes NO handler map — declaring
 * one is a misuse type naming the reason, not a silently inert field.
 */
export const board = agent({
  name: "Claims Board",
  page: "static",
  workflows: {},
});

/** A workflow app, the third door onto the same declaration. */
export const desk = workflowApp({
  name: "Claims Intake",
  workflows: {},
  requiredEnv: ["ASSEMBLYAI_API_KEY"],
});

/** The audited list is read, so the alias is exercised rather than merely named. */
export const auditedCount = AUDITED.length;
