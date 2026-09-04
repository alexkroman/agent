// Copyright 2026 the AAI authors. MIT license.
/**
 * The TEXT-AGENT eval harness: a real `createTextAgent`, driven by what a
 * caller TYPED.
 *
 * The sibling of `eval/session.ts`, and it exists because that one structurally
 * cannot serve a text agent: `openEvalSession` stands up `createRuntime`, which
 * REFUSES `text: true` by name (`textAgentHasNoSession`) — a text agent
 * fills no pipeline stages and resolves no transport, so there is nothing for
 * the fake speech pair to stand between. Two harnesses, one for each of the two
 * ways an agent runs.
 *
 * Everything a case can see is deliberately the same. `send()` is `say()`; it
 * hands back the same {@link EvalTurn}; `events()`, `said()` and `toolCalls()`
 * read the same way; the same readers in `eval/events.ts` and the same
 * assertion vocabulary above them apply, because a text agent emits the same
 * {@link SessionEvent} union narrowed to seven members it can fill honestly
 * (`text-agent-events.ts` carries which, and the eleven it refuses). A case
 * author moving between the two harnesses learns the difference between a
 * voice agent and a text one, and nothing else.
 *
 * What is REAL here: `createTextAgent`, the resolved model on a live key, the
 * step budget, the real tool executor (argument coercion, Standard Schema
 * validation, the per-call deadline, `ctx` and its slots, failure-shaped-as-a-
 * result), the tool-call repair path, and the event stream the assertions read.
 * The only substitution available is the MODEL, through
 * {@link EvalTextAgentOptions.llm} — there are no speech stages to fake.
 *
 * ## Which options are here, and which are refused
 *
 * The voice bag minus what a text agent has no analogue for. `agent`, `env`,
 * `providerEnv`, `llm`, `runCode`, `fetch`, `toolTimeoutMs`, `workflows`,
 * `turnTimeoutMs` and `logger` all mean exactly what they mean there. Absent:
 * `generate`, because a text agent resolves `ctx.generate` from its own
 * descriptor, so `llm` already decides it and a second seam would let the two
 * disagree; and `db`, `model` and `sessionId`, which `createTextAgent` takes
 * and an eval does not choose — the id is minted here in the same `eval-…`
 * shape a session's is, and a `model` would be the resolved value `llm` exists
 * to keep a DESCRIPTOR. Two agent SHAPES are refused outright rather than run:
 * one that does not declare `text: true`, and one that declares `s2s` beside
 * it.
 *
 * ## A turn ends on a real terminator, and here that is structural
 *
 * This is the property the whole harness is for: the next `send()` must not be
 * able to begin inside the previous turn, or a recorded tool order belongs to
 * the harness rather than to the agent. `openEvalSession` gets there by polling
 * the event list for a `TURN_ENDS` member anchored to its own
 * `user-transcript.committed`, because the session it drives runs on its own
 * clock and pushes events at it.
 *
 * Here the harness OWNS the stream, so the wait is stronger and simpler: it
 * consumes the turn's stream to completion, and the terminator is a synchronous
 * consequence of that stream's terminal part (`finish`, `abort` or `error`, all
 * three through one `onChunk`, guarded so the first one wins). So there is no
 * poll and no timer in the success path — `await result.consumeStream()` IS the
 * wait — and a turn that somehow ends with no terminator is reported as a
 * harness fault rather than waited out, because there is nothing left to arrive.
 * A deadline is still armed ({@link EvalTextAgentOptions.turnTimeoutMs}) for the
 * case the harness cannot resolve on its own: a provider that never answers.
 * That one is an `AbortSignal.timeout` handed to the turn, so it CANCELS the
 * turn rather than abandoning a stream that keeps spending tokens.
 *
 * ## One agent, one conversation — which `runTextAgent` deliberately is not
 *
 * `runTextAgent` (`@alexkroman1/aai-runtime/testing`) builds a fresh text agent
 * per call and mandates a script. That is right for a SPEC: one turn, no
 * carry-over, the provider socket the only fake. An eval is the other shape —
 * `sendAll(["…", "…"])` is one conversation, so this builds ONE
 * `createTextAgent` and streams each turn on it, which is what makes
 * `ctx.state` slots, `ctx.messages` and the model's own view of the history
 * mean across turns what they mean in a session. The harness accumulates the
 * conversation itself (a text turn is handed the whole message list, where an
 * utterance reaches a session one at a time), so a case says lines and never
 * assembles `ModelMessage`s.
 *
 * ## The keyless fallback is `installStubLlm`, not `scriptedTextModel`
 *
 * Both exist and they are not interchangeable. This harness takes an
 * {@link LlmProvider} DESCRIPTOR and spreads it onto the agent definition, so a
 * keyless run installs `installStubLlm()`'s kind and everything below the model
 * takes the path a live run takes: the credential resolves through
 * `registerLlmKind` with a real env var, and — because the descriptor is on the
 * DEF rather than a pre-resolved `model` — `ctx.generate` is scripted too. A
 * `scriptedTextModel` handed to `createTextAgent({ model })` would bypass both:
 * `ctx.generate` resolves the agent's own descriptor, so a keyless run would
 * dial a real provider from inside a tool and 401 three layers down, which is
 * exactly the hole `EvalCaseOptions.stubGenerate` was added to close. Its
 * "answer an empty step past the end of the script" rule is also wrong for a
 * harness that cannot know how many model calls a turn will make, where
 * `StubScript`'s repeat-the-last-line rule is right.
 *
 * So the fallback is the tier's existing one and this module adds none of its
 * own: `resolveEvalMode` + `installStubLlm` + `llm` compose unchanged, and the
 * ANNOUNCE stays with whoever owns the policy (`describeEval` for a template,
 * `_gate.ts` for `aai-evals`), exactly as it does for `openEvalSession`. With
 * no credential and no `llm` this throws from `resolveLlm` at OPEN time, naming
 * the env var — loud, and never a green run of nothing.
 *
 * **`evalCredentials` over-asks for a text agent**, which is worth knowing
 * before gating on it: it answers "can this machine run this AGENT", and its
 * no-complete-pipeline branch adds the default AssemblyAI STT key — so a text
 * agent declaring `anthropic()` is reported as needing `ASSEMBLYAI_API_KEY` it
 * will never read. A text agent resolves exactly one provider credential, its
 * LLM's.
 *
 * ## No shipped TEMPLATE exercises these names, and none can
 *
 * The three published here are recorded in
 * `packages/aai-templates/template-api-allowlist.json`, whose gate asks that
 * every public export of an example-facing subpath be exercised by a shipped
 * template — so the entry is a claim, and this is it. A template's agent is a
 * VOICE agent; `createTextAgent` refuses one by name, so a template cannot
 * reach this harness without becoming a different kind of template. It is the
 * same reason `runTextAgent`'s seven names carry, and the same audience: text
 * mode's consumer is a host that embeds the runtime, and the shipped example of
 * one is the studio's own coding agent. The co-located suite drives real turns
 * and `contracts/entrypoints/eval.ts` holds the surface to an epoch either way;
 * what is missing is an example an agent AUTHOR would read, and an agent author
 * does not write one.
 *
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { openEvalTextAgent, toolNames } from "@alexkroman1/aai-runtime/eval";
 *
 * export async function drive(): Promise<void> {
 *   const chat = await openEvalTextAgent({ agent: agent({ name: "Coder", text: true }) });
 *   try {
 *     const turn = await chat.send("add a health route and check it compiles");
 *     console.log(toolNames(turn.toolCalls), turn.text);
 *   } finally {
 *     await chat.close();
 *   }
 * }
 * ```
 *
 * @module
 */

import type { AgentDef } from "@alexkroman1/aai";
import type { ProviderEnv, RunCodeExecutor } from "@alexkroman1/aai/host-internal";
import type { LlmProvider } from "@alexkroman1/aai/llm";
import type { SessionEvent } from "@alexkroman1/aai/protocol";
import { omitUndefined } from "@alexkroman1/aai/utils";
import type { WorkflowClient } from "@alexkroman1/aai/workflow-api";
import type { ModelMessage } from "ai";
import { withHostCredentialFallback } from "../providers/host-env.ts";
import { type Logger, silentLogger } from "../runtime-config.ts";
import { createTextAgent } from "../text-agent.ts";
import { assertTurnMeasurable } from "./_turn-faults.ts";
import { type EvalToolCall, saidIn, TURN_ENDS, toolCallsInEvents } from "./events.ts";
import type { EvalTurn } from "./session.ts";

/**
 * How long one turn may take before the harness cancels it.
 *
 * The same 90s `eval/session.ts` uses, and for the same reason: a live turn
 * with a tool loop in it legitimately runs for tens of seconds, and a deadline
 * a case has to tune is a deadline that fails a slow model rather than a broken
 * one.
 */
const DEFAULT_TURN_TIMEOUT_MS = 90_000;

/** What {@link openEvalTextAgent} takes. */
export type EvalTextAgentOptions = {
  /** The agent under eval. Must declare `text: true`. */
  readonly agent: AgentDef;
  /**
   * The agent's own env, i.e. what its tools read as `ctx.env`. Defaults to
   * empty: a tool that needs a value gets it here, and nothing is inherited
   * implicitly.
   */
  readonly env?: Record<string, string>;
  /**
   * Where provider credentials are resolved from. Defaults to
   * {@link EvalTextAgentOptions.env} with any credential it does not carry
   * filled in from this machine's own environment — the same trust decision
   * `openEvalSession` makes, for the same reason: an eval runs on the
   * developer's box against their own key. A value passed in `env` always wins
   * over the shell.
   */
  readonly providerEnv?: ProviderEnv;
  /**
   * Override the LLM the case runs on. Defaults to the agent's own.
   *
   * A DESCRIPTOR rather than a resolved `LanguageModel`, and it is spread onto
   * the definition rather than passed as `createTextAgent`'s `model`, so the
   * override reaches `ctx.generate` and `ctx.delegate` as well as the turns —
   * see the module doc on why that is what makes the keyless fallback honest.
   */
  readonly llm?: LlmProvider;
  /**
   * Backs the `run_code` builtin. Without one the builtin is registered and
   * permanently refuses, exactly as it does off-platform — the Modal container
   * is the security boundary and nothing here pretends otherwise.
   */
  readonly runCode?: RunCodeExecutor;
  /**
   * The `fetch` the builtin web tools use. Pass one to keep a case off the
   * network — a scripted `visit_webpage` really visits.
   */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Per-tool-call deadline. Defaults to the executor's own (30s, a voice-turn
   * budget), which a text agent whose tools type-check a workspace or install
   * packages will outrun — and then the case measures the deadline instead of
   * the agent.
   */
  readonly toolTimeoutMs?: number;
  /** `ctx.workflows` for this conversation — what a tool that starts a run calls. */
  readonly workflows?: WorkflowClient | undefined;
  /** How long one turn may take before it is cancelled. Defaults to 90s. */
  readonly turnTimeoutMs?: number;
  /** Defaults to silent. Pass `consoleLogger` when diagnosing a case. */
  readonly logger?: Logger;
};

/** One live eval conversation with a text agent. */
export type EvalTextAgent = {
  /**
   * This conversation's id — what its tools read as `ctx.sessionId`.
   *
   * Exposed for the reason `EvalSession.id` is: it is what a tool
   * CORRELATES a durable run with, so a case asserting "the run it started is
   * this conversation's" needs both halves.
   */
  readonly id: string;
  /**
   * Send a user message, wait for the reply to END, and hand back that turn.
   *
   * The wait is `await`ing the turn's own stream rather than a timer — see the
   * module doc — so the next `send()` cannot begin inside this turn and a
   * recorded tool order is the agent's.
   *
   * @throws when nothing about the AGENT can be read off the turn: the model
   *   stream failed, or a tool was called that the agent has no definition for.
   *   Both states are measured PASSING otherwise, because a text agent commits
   *   no transcript on a failed turn and every negative claim then holds
   *   vacuously. Such a turn is NOT appended to the conversation, so a case
   *   that catches the throw does not carry it into the next `send()`;
   *   {@link EvalTextAgent.events} is unaffected and holds what happened.
   */
  send(text: string): Promise<EvalTurn>;
  /**
   * Send every line in order, waiting out each reply, and hand back every turn.
   *
   * Strictly sequential, like the person it stands for, and ONE conversation:
   * each line is sent with every earlier turn's messages in front of it.
   *
   * Assert about the turn a MECHANISM fired in, never about turn number two —
   * how many turns an agent takes to get somewhere is the model's business and
   * it measurably varies. `turnCalling`, `toolCallsInTurns` and `describeTurn`
   * (`eval/turns.ts`) are what read the result without pinning an index, and
   * they take these turns unchanged.
   */
  sendAll(lines: readonly string[]): Promise<readonly EvalTurn[]>;
  /** Every event this conversation has emitted, in stream order. */
  events(): readonly SessionEvent[];
  /**
   * Every committed reply so far.
   *
   * Unlike a session's, this does NOT open with a greeting: `createTextAgent`
   * has no greeting turn at all, so an `agent()` definition's `greeting` — which
   * every definition carries, the factory defaulting it — is dropped in text
   * mode. A case ported from the voice harness is off by one turn until it
   * stops accounting for one.
   */
  said(): readonly string[];
  /** The tool calls so far, in call order, each with its result. */
  toolCalls(): readonly EvalToolCall[];
  /**
   * Release the conversation.
   *
   * Nothing here owns a process-global registration or a live socket, so this
   * is a no-op today and is part of the surface anyway: a case's `try`/`finally`
   * is then the same shape as the voice harness's, and whoever installed a stub
   * model still owns releasing it.
   */
  close(): Promise<void>;
};

/**
 * Open an eval conversation against a real text agent.
 *
 * The definition is used AS GIVEN — including its `events` hooks, its slots and
 * its `tools/` files — with the model as the only substitution available.
 *
 * `async` although nothing is awaited, so the surface matches
 * `openEvalSession`'s: a case reads `await open…(); try { … } finally { await
 * close(); }` either way, and the two harnesses cannot come to want different
 * boilerplate.
 *
 * @throws if the agent does not declare `text: true`. That is the mirror of
 *   `createTextAgent`'s own refusal, made here so the message names the harness
 *   to use instead.
 * @throws if the agent declares `s2s`. The vendor owns the whole turn there and
 *   a text agent has no speech stage at all, so running it as one would evaluate
 *   a configuration nobody deployed. `AgentParams` refuses the pair at COMPILE
 *   time with a message of its own; this is the other door — a raw
 *   `export default {…}`, or a definition loaded from a config, arrives having
 *   skipped it.
 */
export async function openEvalTextAgent(options: EvalTextAgentOptions): Promise<EvalTextAgent> {
  const def = options.agent;
  if (def.text !== true) {
    throw new Error(
      `Agent "${def.name}" does not declare \`text: true\`, so it has no text ` +
        "turn to drive — evaluate it as a voice session with `openEvalSession`, " +
        "or add `text: true` to its definition.",
    );
  }
  if (def.s2s !== undefined) {
    throw new Error(
      `Agent "${def.name}" declares both \`text: true\` and an s2s provider, which ` +
        "owns a whole SPOKEN turn — a text agent has no speech stage, so this " +
        "would evaluate a configuration nobody deployed. Drop one of the two.",
    );
  }

  const events: SessionEvent[] = [];
  const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const providerEnv = options.providerEnv ?? withHostCredentialFallback({ ...options.env });
  const id = `eval-text-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const chat = createTextAgent({
    // The override rides on the DEFINITION, which is what carries it to
    // `ctx.generate` and `ctx.delegate` as well as to the turn's model. One
    // `omitUndefined` rather than a conditional spread: `guard-invariants` rule 2.
    agent: { ...def, ...omitUndefined({ llm: options.llm }) },
    env: { ...options.env },
    providerEnv,
    sessionId: id,
    onEvent: (event) => {
      events.push(event);
    },
    ...omitUndefined({
      workflows: options.workflows,
      runCode: options.runCode,
      fetch: options.fetch,
      toolTimeoutMs: options.toolTimeoutMs,
    }),
    logger: options.logger ?? silentLogger,
  });

  // The RESOLVED set — the agent's own tools plus whichever builtins it
  // enabled, which is what the model was offered. Read off the agent rather
  // than recomputed from `def.tools`, so the diagnosis cannot come to disagree
  // with what the model saw.
  const toolNames = Object.keys(chat.tools);
  const messages: ModelMessage[] = [];

  // A binding rather than a method on the literal below, so `sendAll` reaches
  // it without `this` — a handle destructured out of a case's context is
  // exactly the shape that makes a `this`-bound method fail somewhere the type
  // checker cannot see.
  const send = async (text: string): Promise<EvalTurn> => {
    const from = events.length;
    const said: ModelMessage = { role: "user", content: text };
    // The deadline CANCELS the turn rather than abandoning it: an abandoned
    // provider stream keeps spending tokens, and the abort reaches the tool
    // executor's own `ctx.signal` too.
    const deadline = AbortSignal.timeout(turnTimeoutMs);
    const result = chat.stream({ messages: [...messages, said], signal: deadline });
    // `streamText` is LAZY — none of its promises settle until the stream is
    // consumed — and consuming it here is ALSO the turn wait: the terminator is
    // emitted from the stream's own terminal part, so it has passed through by
    // the time this resolves. A failure is captured rather than thrown, because
    // the diagnosis below names it better than the raw provider error does.
    let failure: { error: unknown } | undefined;
    await result.consumeStream({
      onError: (error) => {
        failure ??= { error };
      },
    });
    const turn = events.slice(from);
    const what = `the reply to ${JSON.stringify(text.slice(0, 60))}`;
    if (deadline.aborted) {
      throw new Error(
        `eval text agent timed out after ${turnTimeoutMs}ms waiting for ${what}; ` +
          `events since: ${turn.map((e) => e.type).join(", ") || "none"}`,
      );
    }
    // Only when the stream reported nothing itself: an `error` part becomes an
    // `error.reported` frame, and `assertTurnMeasurable` is what turns that
    // into a message naming the credential. A failure with no frame is one
    // this module cannot explain, so it goes up as it is.
    if (failure !== undefined && !turn.some((e) => e.type === "error.reported")) {
      throw failure.error;
    }
    if (!turn.some((e) => TURN_ENDS.has(e.type))) {
      throw new Error(
        `eval text agent: ${what} ended with no reply.completed or reply.cancelled, so ` +
          "there is no turn boundary to read it against. Every event of a text turn " +
          "comes from one consumed stream, so this is a harness fault rather than " +
          `something to wait out; events since: ${turn.map((e) => e.type).join(", ") || "none"}`,
      );
    }
    assertTurnMeasurable(what, turn, toolNames, "text");
    // Appended only for a turn that can be read: the conversation the next
    // `send()` builds on holds what really happened, and a turn nothing can be
    // read off is not carried into it.
    messages.push(said, ...(await result.responseMessages));
    return {
      text: saidIn(turn).join(" "),
      events: turn,
      toolCalls: toolCallsInEvents(turn),
      completed: turn.some((e) => e.type === "reply.completed"),
    };
  };

  return {
    id,
    send,
    async sendAll(lines) {
      const turns: EvalTurn[] = [];
      // Sequential on purpose: `send()` returns when the reply to ITS message
      // ends, so awaiting each in turn is what keeps the next line out of the
      // previous turn.
      for (const line of lines) turns.push(await send(line));
      return turns;
    },
    events: () => events,
    said: () => saidIn(events),
    toolCalls: () => toolCallsInEvents(events),
    close: async () => {
      // Nothing to unwind — see `EvalTextAgent.close`.
    },
  };
}
