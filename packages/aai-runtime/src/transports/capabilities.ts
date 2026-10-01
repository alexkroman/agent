// Copyright 2026 the AAI authors. MIT license.
/**
 * What works on which transport, stated ONCE.
 *
 * Every transport answers {@link TransportCapabilities} as
 * `Transport.capabilities`, and every reader that used to probe a verb's
 * presence (`transport.speakLine?.(…)`, `transport.injectTurn === undefined`)
 * or carry its own "S2S cannot" paragraph reads a flag here instead. The point
 * is WHERE an absence is handled: at `agent()` (the SDK's `config-rules.ts`
 * refuses pipeline-only config by mode), at SESSION START (the runtime warns
 * once, from these rows, for a declared feature this transport cannot apply,
 * and logs what code-driven verbs will do instead), or as a client command the
 * transport ignores. Never a degraded branch at the call.
 *
 * The guide's capability table (`transports/CLAUDE.md`) is rendered from
 * {@link CAPABILITY_ROWS} and the three descriptors by
 * {@link renderCapabilityTable}; `capabilities.test.ts` fails when the two
 * disagree, and when a descriptor claims a verb its transport does not
 * implement (or the reverse).
 *
 * @module
 */

import type { Logger } from "../runtime-config.ts";

/**
 * The optional {@link Transport} verbs a capability is carried by. Spelled out
 * rather than derived from `Transport` (whose `capabilities` member is typed by
 * this module, so a mapped type over it is circular); `capabilities.test.ts`
 * holds the list to the interface.
 *
 * @internal
 */
export type TransportVerb =
  | "speakLine"
  | "isReplying"
  | "injectTurn"
  | "sendUserText"
  | "startUserTurn"
  | "commitUserTurn"
  | "clearUserTurn"
  | "reset"
  | "seedHistory"
  | "onPlaybackProgress"
  | "refreshSystemPrompt";

/**
 * One row of the table: the feature in an author's terms, the optional verbs
 * that carry it (implemented iff the flag is `true`), and what happens where it
 * is absent.
 */
type CapabilityRow = {
  readonly feature: string;
  readonly verbs: readonly TransportVerb[];
  /** Where an absence is handled, and how — the table's last column. */
  readonly absent: string;
  /** A declared-feature row warned about at session start (see below). */
  readonly warnAtStart?: string;
};

/**
 * Every capability, with its row. The `satisfies` makes the key set the type,
 * so a capability added here is a compile error in each descriptor below.
 *
 * @internal
 */
export const CAPABILITY_ROWS = {
  say: {
    feature: "`speech.say()` — speak host text VERBATIM (`interruptible`, `record`)",
    verbs: ["speakLine"],
    absent: "logged at session start; every `say` settles `dropped`",
  },
  replyState: {
    feature: "`speech.interrupt()` knows whether a reply is in flight",
    verbs: ["isReplying"],
    absent: '"cannot tell" interrupts, as the client\'s blind `cancel` does',
  },
  announce: {
    feature: "an unprompted MODEL turn — a run's `notify`, `ServerSession.announce`",
    verbs: ["injectTurn"],
    absent: "logged at session start; `announce` answers `false`",
  },
  typedTurn: {
    feature: "a typed user turn (`user_text`)",
    verbs: ["sendUserText"],
    absent: "client command ignored, warned once per session",
  },
  manualTurn: {
    feature: 'push-to-talk (`turnTaking: { detection: "manual" }`)',
    verbs: ["startUserTurn", "commitUserTurn", "clearUserTurn"],
    absent: "refused by `agent()`; client commands ignored, warned once per session",
  },
  reset: {
    feature: "client `reset` clears the conversation and re-greets",
    verbs: ["reset"],
    absent: "ignored — the service holds the conversation (a known gap)",
  },
  seedHistory: {
    feature: "a resume re-seeds the host-held model history",
    verbs: ["seedHistory"],
    absent: "nothing to seed — the service resumes its own context",
  },
  playbackProgress: {
    feature: "client `playback_progress` corrects the heard clock",
    verbs: ["onPlaybackProgress"],
    absent: "ignored — the host keeps no playback model",
  },
  promptPush: {
    feature: "a changed system prompt is PUSHED to the service",
    verbs: ["refreshSystemPrompt"],
    absent: "pipeline: resolved per request, nothing to push",
  },
  perTurnPrompt: {
    feature: "the system prompt is re-resolved between turns (a `dialog()` phase, a persona)",
    verbs: [],
    absent: "resolved ONCE at construction; a phase is learned through tool results",
  },
  dialogKnobs: {
    feature: "a dialog state's `interruption` / `toolChoice` / `temperature`",
    verbs: [],
    absent: "warned at session start; states, deadlines and tool gates still work",
    warnAtStart:
      "This agent's dialogs declare per-state interruption/toolChoice/temperature, and the {transport} transport applies none of them: that service assembles each request and owns turn-taking, so there is no per-turn moment in this process to apply one at. The dialog's states, instructions, deadlines and tool gates all still work — only these three knobs are inert.",
  },
  personaKnobs: {
    feature: "a persona's `interruption` / `toolChoice` / `temperature`",
    verbs: [],
    absent: "warned at session start; the prompt section and tool gate still hold",
    warnAtStart:
      "This agent's personas declare interruption/toolChoice/temperature, and the {transport} transport applies none of them: that service assembles each request and owns turn-taking. Every persona's prompt section still reaches the model, and another persona's tool still refuses at execution.",
  },
  fatalTool: {
    feature: "a tool's `onError` FATAL verdict stops the turn and speaks `errorPhrase`",
    verbs: [],
    absent:
      "warned at session start; a fatal verdict reaches the model as a failure result instead",
    warnAtStart:
      "This agent's tools declare onError, and the {transport} transport cannot stop a turn on a FATAL verdict: the service runs the turn and has no abort the host can send. A fatal verdict there reaches the model as an ordinary failure result.",
  },
  turnMetrics: {
    feature: "one `metrics.collected` frame per settled reply (S2S: round trip only)",
    verbs: [],
    absent: "no frame",
  },
  hostedTurn: {
    feature:
      "the HOST runs the model turn: guardrails, `usageLimits`, model tuning, pipeline voice tuning",
    verbs: [],
    // The session core reads this row too: on a hosted turn a reported
    // `tool.called` already ran (an observation); otherwise it is a request the
    // session executes (`../session/core.ts`).
    absent: "refused by `agent()` (`config-rules.ts`); the session runs reported tool calls",
  },
} as const satisfies Record<string, CapabilityRow>;

/** A capability's name. @internal */
export type TransportCapability = keyof typeof CAPABILITY_ROWS;

/** What one transport can do — one flag per {@link CAPABILITY_ROWS} row. @internal */
export type TransportCapabilities = Readonly<Record<TransportCapability, boolean>>;

/** Pipeline mode: the host owns every stage, so everything. @internal */
export const PIPELINE_CAPABILITIES: TransportCapabilities = {
  say: true,
  replyState: true,
  announce: true,
  typedTurn: true,
  manualTurn: true,
  reset: true,
  seedHistory: true,
  playbackProgress: true,
  promptPush: false,
  perTurnPrompt: true,
  dialogKnobs: true,
  personaKnobs: true,
  fatalTool: true,
  turnMetrics: true,
  hostedTurn: true,
};

/** Both S2S services own the conversation, turn-taking and the request. */
const S2S_BASE: TransportCapabilities = {
  say: false,
  replyState: false,
  announce: false,
  typedTurn: false,
  manualTurn: false,
  reset: false,
  seedHistory: false,
  playbackProgress: false,
  promptPush: false,
  perTurnPrompt: false,
  dialogKnobs: false,
  personaKnobs: false,
  fatalTool: false,
  // The round trip only: the service reports no boundary between its stages,
  // so `stt`/`llm`/`tts` stay absent (`s2s-turn-metrics.ts`).
  turnMetrics: true,
  hostedTurn: false,
};

/**
 * OpenAI Realtime: `instructions` is service state, pushed on change — so the
 * prompt moves between turns. @internal
 */
export const OPENAI_REALTIME_CAPABILITIES: TransportCapabilities = {
  ...S2S_BASE,
  promptPush: true,
  perTurnPrompt: true,
};

/** AssemblyAI S2S: the service runs the tool loop; the prompt is fixed at open. @internal */
export const ASSEMBLYAI_S2S_CAPABILITIES: TransportCapabilities = S2S_BASE;

/** The three descriptors, as the table's columns. @internal */
export const TRANSPORT_DESCRIPTORS = [
  ["pipeline", PIPELINE_CAPABILITIES],
  ["OpenAI Realtime", OPENAI_REALTIME_CAPABILITIES],
  ["AssemblyAI S2S", ASSEMBLYAI_S2S_CAPABILITIES],
] as const;

const CAPABILITY_NAMES = Object.keys(CAPABILITY_ROWS) as readonly TransportCapability[];

/**
 * The guide's capability table, as markdown — the block between the
 * `capability-table` markers in `transports/CLAUDE.md`.
 *
 * @internal
 */
export function renderCapabilityTable(): string {
  const head = `| capability | feature | ${TRANSPORT_DESCRIPTORS.map(([name]) => name).join(" | ")} | where absent |`;
  const rule = `| --- | --- | ${TRANSPORT_DESCRIPTORS.map(() => "---").join(" | ")} | --- |`;
  const rows = CAPABILITY_NAMES.map((name) => {
    const row: CapabilityRow = CAPABILITY_ROWS[name];
    const cells = TRANSPORT_DESCRIPTORS.map(([, caps]) => (caps[name] ? "yes" : "no"));
    return `| \`${name}\` | ${row.feature} | ${cells.join(" | ")} | ${row.absent} |`;
  });
  return [head, rule, ...rows].join("\n");
}

/** What a session declared, of the features {@link reportSessionCapabilities} checks. @internal */
export type DeclaredFeatures = {
  readonly dialogKnobs: boolean;
  readonly personaKnobs: boolean;
  readonly fatalTool: boolean;
};

/**
 * Session start: warn once for each DECLARED feature `capabilities` cannot
 * apply, and log once which code-driven verbs this transport lacks — the one
 * place either is said, so no call site degrades with a warning of its own.
 *
 * `once` is the runtime's latch (a set of keys already said), so a busy agent
 * says each line once per process rather than once per call.
 *
 * @internal
 */
export function reportSessionCapabilities(
  capabilities: TransportCapabilities,
  transportName: string,
  declared: DeclaredFeatures,
  log: Logger,
  once: Set<string>,
): void {
  const say = (key: string, line: () => void): void => {
    if (once.has(key)) return;
    once.add(key);
    line();
  };
  for (const name of ["dialogKnobs", "personaKnobs", "fatalTool"] as const) {
    if (!declared[name] || capabilities[name]) continue;
    say(name, () =>
      log.warn(CAPABILITY_ROWS[name].warnAtStart.replace("{transport}", transportName)),
    );
  }
  const missing = (["say", "announce"] as const).filter((name) => !capabilities[name]);
  if (missing.length === 0) return;
  say("verbs", () =>
    log.info(`The ${transportName} transport has no host-spoken turns`, {
      transport: transportName,
      unavailable: missing.map((name) => `${name}: ${CAPABILITY_ROWS[name].absent}`),
    }),
  );
}
