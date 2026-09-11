// Copyright 2026 the AAI authors. MIT license.
/**
 * The slow tier's tool surface: the agent's own tools with a mandatory digest
 * argument welded on, plus the three tools that reach the caller.
 *
 * ## The digest rides on the ARGUMENTS, and that is the whole trick
 *
 * TalkAct's mechanism, quoted from its own source: "Every action tool carries a
 * required `state_summary` field — the agent's rolling digest of task progress
 * and on-screen facts. The bridge exposes it to the fast voice agent, which is
 * how the fast agent stays grounded without waiting on the slow loop." Their
 * report states the cost: "A required `state_summary` argument on every slow
 * tool call keeps the blackboard current with zero additional model calls."
 *
 * Both halves matter. A summary asked for AFTERWARDS is a second request the
 * caller waits through. A summary the fast tier is asked to write is the fast
 * tier's own belief, which is what hallucinated completion is made of. Asked
 * for as an argument on the same call, it is free and it is the acting model's.
 *
 * ## Where ask_user / tell_user land, and why there is no second channel
 *
 * TalkAct needs two asyncio queues (`fast_to_slow`, `slow_to_fast`) because its
 * fast agent is the only thing that hears the caller and the only thing that
 * can speak. Neither is true here, so both queues collapse onto plumbing this
 * runtime already has:
 *
 * - **slow → fast** is `Transport.injectTurn`, the verb that already exists for
 *   "a durable run finished, tell the caller". `tell_user` and `ask_user` differ
 *   only in the instruction they hand it. The fast tier then says it in its own
 *   words, on its own latency, with the digest in front of it.
 * - **fast → slow** is the session's own transcript. Every committed caller
 *   utterance is relayed by the runtime (see `session.ts`), so the slow tier
 *   reads the answer to its question in the conversation like any other line.
 *
 * That is strictly better than the queues for our fast tier, not merely
 * equivalent: TalkAct's `@slow:` relay depends on the fast model remembering to
 * emit a directive, and its own code carries regexes to strip the scaffolding
 * small models echo into speech instead. A tool-free 4B model cannot be relied
 * on for a protocol, and here it is not asked to be.
 */

import type { ToolSchema } from "@alexkroman1/aai/manifest";
import type { JSONSchema7 } from "json-schema";
import { STATE_SUMMARY_DESCRIPTION } from "./prompt.ts";

/** The argument every slow-tier tool gains. */
export const STATE_SUMMARY_ARG = "state_summary";

/** Speak something to the caller. */
export const TELL_USER = "tell_user";
/** Ask the caller for something, and keep working. */
export const ASK_USER = "ask_user";
/** Report the work finished. */
export const TASK_DONE = "task_done";

/** The three tools the agent did not declare. */
export const CHANNEL_TOOLS: readonly string[] = [TELL_USER, ASK_USER, TASK_DONE];

const SUMMARY_PROPERTY: JSONSchema7 = {
  type: "string",
  description: STATE_SUMMARY_DESCRIPTION,
};

/**
 * Add the required `state_summary` argument to one tool's parameters.
 *
 * **The agent's own property of that name WINS**, and the tool is left alone.
 * A tool that already takes a `state_summary` is vanishingly unlikely and
 * silently breaking it is not — overwriting the author's property would change
 * what their `execute` receives, and the strip below would then delete a
 * required argument on its way in. The tool simply carries no digest
 * obligation; `session.ts` logs the name once so it is a finding rather than a
 * silence.
 */
export function withSummaryArg(schema: ToolSchema): {
  readonly schema: ToolSchema;
  readonly carriesSummary: boolean;
} {
  const props = (schema.parameters.properties ?? {}) as Record<string, unknown>;
  if (Object.hasOwn(props, STATE_SUMMARY_ARG)) return { schema, carriesSummary: false };
  const required = Array.isArray(schema.parameters.required) ? schema.parameters.required : [];
  return {
    carriesSummary: true,
    schema: {
      ...schema,
      parameters: {
        ...schema.parameters,
        properties: { ...props, [STATE_SUMMARY_ARG]: SUMMARY_PROPERTY },
        required: [...required, STATE_SUMMARY_ARG],
      },
    },
  };
}

/**
 * Split a call's arguments into the digest summary and what the tool gets.
 *
 * The summary is REMOVED rather than passed through, because the tool's own
 * `inputSchema` is validated by `executeToolCall` and a zod object refuses an
 * unknown key — so leaving it in would fail every gated call with a schema
 * error about a field the author never declared.
 */
export function takeSummary(args: Readonly<Record<string, unknown>>): {
  readonly summary: string;
  readonly rest: Readonly<Record<string, unknown>>;
} {
  if (!Object.hasOwn(args, STATE_SUMMARY_ARG)) return { summary: "", rest: args };
  const { [STATE_SUMMARY_ARG]: summary, ...rest } = args;
  return { summary: typeof summary === "string" ? summary : "", rest };
}

/**
 * One channel tool, WITHOUT the digest argument.
 *
 * Deliberately not pre-added here: {@link withSummaryArg} is the one place the
 * argument is attached, and these schemas go through it like the agent's own.
 * Adding it in both made these three look, to that function, like tools whose
 * AUTHOR had claimed the name — so the session warned about its own channel on
 * every boot, which is exactly the kind of line that teaches a reader to stop
 * reading the log.
 *
 * `additionalProperties` is therefore left OFF: `withSummaryArg` adds a
 * property, and a schema that forbade unknown ones would refuse its own digest
 * argument.
 */
function channelSchema(
  name: string,
  description: string,
  field: string,
  prompt: string,
): ToolSchema {
  return {
    type: "function",
    name,
    description,
    parameters: {
      type: "object",
      properties: { [field]: { type: "string", description: prompt } },
      required: [field],
    },
  };
}

/**
 * The three tools that reach the caller.
 *
 * `task_done` is declared `completes` so it goes through the same digest gate
 * an author's own hand-off tool does — the slow tier is not exempt from the
 * rule that nothing reports finished while something is outstanding. It is the
 * one of the three that is: `tell_user` and `ask_user` change nothing and are
 * how the gate's refusal gets spoken, so gating them would leave a blocked run
 * unable to say why.
 */
export function channelToolSchemas(): readonly ToolSchema[] {
  return [
    channelSchema(
      TELL_USER,
      "Say something to the customer — progress, a finding, a confirmation. Your colleague will " +
        "put it in their own words. Use this rather than staying silent through a long stretch of work.",
      "text",
      "What the customer should be told.",
    ),
    channelSchema(
      ASK_USER,
      "Ask the customer for something you need. Keep working on anything that does not depend on " +
        "the answer; it will appear in the conversation when they give it.",
      "question",
      "What to ask the customer.",
    ),
    {
      ...channelSchema(
        TASK_DONE,
        "Report that the work is finished, or that it cannot be done. Say what the outcome was.",
        "result",
        "What the outcome was.",
      ),
      completes: true,
    },
  ];
}

/** What a channel call asks the session to do. @internal */
export type ChannelEffect =
  | { readonly kind: "tell"; readonly text: string }
  | { readonly kind: "ask"; readonly question: string }
  | { readonly kind: "done"; readonly result: string };

/**
 * Classify a channel call, or `undefined` when the name is not one of the three.
 *
 * A missing or non-string field answers `undefined` rather than an effect with
 * an empty payload: a `tell_user` with no text would inject a turn instructing
 * the fast tier to say nothing, which reaches the caller as an unprompted
 * utterance about nothing.
 */
export function channelEffectOf(
  name: string,
  args: Readonly<Record<string, unknown>>,
): ChannelEffect | undefined {
  const field = (key: string): string | undefined =>
    typeof args[key] === "string" && (args[key] as string).trim() !== ""
      ? (args[key] as string)
      : undefined;
  if (name === TELL_USER) {
    const text = field("text");
    return text === undefined ? undefined : { kind: "tell", text };
  }
  if (name === ASK_USER) {
    const question = field("question");
    return question === undefined ? undefined : { kind: "ask", question };
  }
  if (name === TASK_DONE) {
    const result = field("result");
    return { kind: "done", result: result ?? "(no outcome given)" };
  }
  return undefined;
}

/**
 * The instruction `injectTurn` is handed for one channel effect.
 *
 * An INSTRUCTION rather than the words to speak, because `injectTurn` runs a
 * real fast-tier turn: the model is told what to convey and says it in the
 * register the rest of the call is in, with the digest beside it. Handing it a
 * finished sentence would make the slow tier's phrasing the caller's
 * experience, which is the one thing a model chosen for latency is better at.
 */
export function injectInstructionFor(effect: ChannelEffect): string {
  if (effect.kind === "tell") return `Tell the customer, in your own words: ${effect.text}`;
  if (effect.kind === "ask") return `Ask the customer, in your own words: ${effect.question}`;
  return `The work is finished. Tell the customer the outcome, in your own words: ${effect.result}`;
}

/**
 * The refusal a `completes` call gets while work is outstanding — DIGEST-GATED
 * COMPLETION.
 *
 * The MESSAGE, which the caller hands to `serializeToolFailure` — so the slow
 * tier reads it as an ordinary recoverable tool failure rather than as a throw.
 * That routing is the decision: per `TOOL-OUTCOMES-CLAUDE.md`, a returned
 * failure is the channel for "the model can recover from this", and recovering
 * is exactly what should happen — finish the outstanding work, then report
 * again. A throw would be classified as a bug and, under an `onError` that
 * re-raises, would end the run.
 */
export function completionRefusal(pending: readonly string[]): string {
  const names = pending.join(", ");
  return (
    `Not finished: ${names} ${pending.length === 1 ? "is" : "are"} still outstanding. ` +
    "Complete or resolve it before reporting the work done."
  );
}
