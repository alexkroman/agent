// Copyright 2026 the AAI authors. MIT license.
/**
 * The studio coding agent's own eval harness — the templates' eval suite,
 * pointed at `createStudioAgent`.
 *
 * "The coding agent has an eval of its own" in `packages/aai-guest/CLAUDE.md`
 * carries the account: why it is in this package rather than in `aai-evals`,
 * what it measures that the HTTP starter eval cannot and vice versa, and the
 * one honest limit — the system prompt. Four facts belong at this seam, because
 * they are the ones a reader of this file would otherwise have to infer:
 *
 * - **The suite is the templates', not a second one.** Everything above the
 *   model comes from `@alexkroman1/aai-runtime/eval`, the subpath the
 *   twenty-five shipped template evals drive; `resolveEvalMode` is the same
 *   credential gate `describeEval` runs and `installStubLlm` the same scripted
 *   fallback. What is NOT reused is `describeEval` itself, and it is structural:
 *   that function stands up `openEvalSession` → `createRuntime`, which REFUSES
 *   `text: true` by name. `openEvalTextAgent`'s module doc names the split and
 *   says where the announce then belongs — "`describeEval` for a template,
 *   `_gate.ts` for `aai-evals`" — and this module is that third owner.
 * - **What is real:** `initStudioSession` (so the tree is materialized,
 *   completed into a project, and its declared dependencies reified), the four
 *   tool families and three web builtins, the SDK's tool executor with its `ctx`
 *   and the 120s studio deadline, the reserved final-answer step,
 *   `typecheckWorkspaceDir` behind the post-write diagnostics, and
 *   `studioBundleAccess` — the same loader and trial executor `harness.ts`
 *   hands the chat surface, so `test_agent` really builds, loads and trials.
 * - **What is NOT:** the system prompt (see {@link STUDIO_EVAL_PROMPT}), and
 *   `studio/chat.ts`'s turn shaping — the wall-clock `stopWhen`, compaction's
 *   `prepareStep`, the mid-turn checkpoints and the end-of-turn sync. Those are
 *   the HTTP surface's, and `studio/chat.scenario.test.ts` exercises them.
 * - **It replaces nothing.** The HTTP starter eval in `aai-evals` measures the
 *   DEPLOYED path — the broker, the per-sandbox token, the guest chat route, the
 *   workspace sync — which is where the harness it replaced had rotted. Keep
 *   both; convert neither.
 *
 * @module
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ASSEMBLYAI_LLM_API_KEY_ENV } from "@alexkroman1/aai/host-internal";
import { omitUndefined } from "@alexkroman1/aai/utils";
import {
  type EvalTextAgent,
  installStubLlm,
  openEvalTextAgent,
  type StubScript,
} from "@alexkroman1/aai-runtime/eval";
import { type EvalMode, resolveEvalMode } from "@alexkroman1/aai-runtime/eval/vitest";
import { afterEach, beforeEach, describe, test } from "vitest";
import { type FakeHostChannel, installFakeHostChannel } from "../_test-utils.ts";
import { setHostSend } from "../harness/rpc.ts";
import { type StudioPromptKind, shippedStudioPrompt } from "./_eval-prompt.ts";
import { createStudioAgent, STUDIO_TOOL_TIMEOUT_MS } from "./agent.ts";
import { typecheckWorkspaceDir } from "./build.ts";
import { studioBundleAccess } from "./bundle-access.ts";
import { initStudioSession, type StudioSession } from "./session.ts";
import { bundledTemplatesRoot } from "./template-tools.ts";
import { runWorkspaceTests } from "./test.ts";
import { HARD_TURN_MS } from "./turn-budget.ts";
import type { TypecheckResult } from "./write-diagnostics.ts";

/**
 * The gateway model a live case runs the coding agent on.
 *
 * The shipped default is `studioLlmModelId()` in
 * `packages/aai-studio-server/src/studio-llm.ts`, which this package may not
 * import (`guest-package-boundary`) — so it is a literal here with an env
 * override, and the literal WILL drift when the studio changes model. That is
 * the cheaper failure of the two available: a drifted default measures the
 * coding agent on a model the studio no longer serves, which a reader can see
 * in the announce line below; a dynamic import across the boundary would make
 * the guest link against the host to run a test.
 */
const DEFAULT_STUDIO_EVAL_MODEL = "gpt-5.5";

/**
 * Step budget for a case, well under the studio's shipped 80
 * (`MAX_CHAT_STEPS`).
 *
 * Not fidelity for its own sake: a case that needs eighty steps is not making a
 * crisp claim about anything, and the reserved final-answer step means a capped
 * turn still ends on something readable rather than mid-tool — so a case that
 * hits this cap fails on its assertions, with the tool list in the message,
 * rather than hanging. Raise it per case where the claim genuinely needs the
 * room.
 */
const DEFAULT_STUDIO_EVAL_STEPS = 14;

/**
 * The base system prompt a case runs on — NOT the shipped one.
 *
 * The studio's is `studioSystemPrompt(kind)` in
 * `packages/aai-studio-server/src/prompts/`, and `guest-package-boundary`
 * denies this package that import — correctly, since the guest must not link
 * against the host. So this is deliberately thin, and thin in one specific
 * direction: it states the job and says nothing that would pre-answer a case.
 * A prompt here that told the agent to copy templates verbatim, or not to
 * delete a failing spec, would make the corresponding case a measurement of
 * this constant rather than of the agent — so those instructions are left to
 * the guest's own surfaces, which are the thing under eval
 * (`STUDIO_TOOL_DESCRIPTIONS`, each tool's result prose, and the
 * `toolchainPromptSection()` that `initStudioSession` appends to this).
 */
export const STUDIO_EVAL_PROMPT =
  "You are the AAI Studio coding agent. You build and edit voice agents written " +
  "with the AAI SDK, working directly in a workspace on disk through your tools. " +
  "Use the tools to inspect and change the workspace rather than describing " +
  "changes you have not made, and finish by telling the user what you did.";

/** Where a case's own turns and assertions meet the workspace. */
export type StudioEvalContext = {
  /** The coding-agent conversation, driven with `send` / `sendAll`. */
  readonly chat: EvalTextAgent;
  /** The session workspace root the tools are bound to. */
  readonly dir: string;
  /** LIVE or SCRIPTED — announced once per file. A case may branch; most should not. */
  readonly mode: EvalMode;
  /** The guest→host requests this case's tools made, in order. */
  readonly hostCalls: () => readonly { readonly method: string; readonly params: unknown }[];
  /** A workspace file's contents, or null when it is not there. */
  read(rel: string): Promise<string | null>;
  /** Does this workspace path exist? */
  exists(rel: string): Promise<boolean>;
  /**
   * GROUND TRUTH: does the workspace the agent left behind compile?
   *
   * The same `typecheckWorkspaceDir` the post-write diagnostics run, called by
   * the CASE rather than by a tool — so the claim is about the tree on disk and
   * not about what any tool result said about it. This is the one assertion in
   * the suite a model cannot satisfy with prose.
   */
  typecheck(): Promise<TypecheckResult>;
  /** GROUND TRUTH: the workspace's own tests, run the way `test_agent` runs them. */
  runTests(): ReturnType<typeof runWorkspaceTests>;
  /**
   * A shipped template file as it exists in the baked toolchain — the bytes
   * `use_template` copies.
   *
   * For the one claim that needs both sides: a template used is byte-identical,
   * a template retyped is not.
   */
  templateFile(template: string, rel: string): Promise<string>;
};

/** What a case gets to say about how it should be run. */
export type StudioEvalCaseOptions = {
  /**
   * The workspace this case starts from. Materialized fresh per case, then
   * completed into a real project by `ensureProjectShape` exactly as a session
   * install does.
   */
  readonly files?: Record<string, string>;
  /**
   * What a SCRIPTED model does when this file runs without a key — one entry per
   * model call, the last repeating. Same type and same rule as
   * `EvalCaseOptions.stubReply`: choose it so the case's own assertions still
   * hold, because a stub run the case then fails against measures nothing.
   */
  readonly stubReply?: StubScript;
  /** This claim only means something against a live model; SKIPPED in stub mode. */
  readonly live?: boolean;
  /**
   * The mirror: only a SCRIPT can reach this, so it is skipped live.
   *
   * The same three-case need `EvalCaseOptions.scripted` records, arriving here
   * for the same reason: a refusal can only be observed if something calls the
   * refused thing, and a competent model declines to write unparsable
   * TypeScript or to address a path outside its workspace.
   */
  readonly scripted?: boolean;
  /** Raise the step budget for a claim that needs the room. */
  readonly maxSteps?: number;
  /**
   * The `fetch` the three web builtins use. Defaults to one that REFUSES, so a
   * case cannot silently spend a live web search or reach the network from CI —
   * pass one to grade a builtin that must really answer.
   */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Which system prompt this case runs on. Defaults to the harness's.
   *
   * The default is right for a case whose subject is a GUEST surface — a tool's
   * refusal wording, its result prose — and `studio/_eval-prompt.test.ts` pins
   * {@link STUDIO_EVAL_PROMPT} thin precisely so those cases cannot be
   * pre-answered by it. It is wrong for a case whose subject is an OUTCOME:
   * what the agent builds from a product prompt is largely a measurement of the
   * studio's own prompt, so those pass a kind here and run the shipped text.
   *
   * Per case rather than per file, because the suite legitimately holds both
   * kinds of claim and a global switch would silently change what the refusal
   * cases mean.
   */
  readonly studioPrompt?: StudioPromptKind;
};

/** How a case is declared. Named `test` at the call site — see `EvalTest`. */
export type StudioEvalTest = (
  name: string,
  body: (ctx: StudioEvalContext) => Promise<void>,
  options?: StudioEvalCaseOptions,
) => void;

/**
 * Say something the HARNESS did, on a stream a reporter cannot swallow.
 *
 * Not `console.*`: vitest intercepts it and hands the capture to the resolved
 * reporter, and vitest 4's agent reporter prints a PASSING file's captured
 * output nowhere — which is every line this module writes, since the mode
 * announce is about a file that passes. The full measurement is in
 * `aai-runtime`'s `eval/_announce.ts` and in `aai-evals`' `_gate.ts`
 * (`sayFromHarness`); this is the third owner of the same rule, and it is three
 * lines rather than an import because `evals-package-boundary` and
 * `_announce.ts` being private put both copies out of reach.
 */
function sayFromHarness(text: string): void {
  process.stderr.write(`${text}\n`);
}

/**
 * The model id a live case resolves, and the announce line's subject.
 *
 * Exported for `studio/_eval-harness.test.ts` — this module's own seams. A
 * harness whose behaviour nothing claims is a harness that can be wrong in the
 * direction that makes an eval report a finding about itself.
 */
export function studioEvalModel(): string {
  const named = process.env.AAI_EVAL_STUDIO_MODEL?.trim();
  return named === undefined || named === "" ? DEFAULT_STUDIO_EVAL_MODEL : named;
}

/**
 * A definition shaped exactly like the one a case will run, for the credential
 * question alone.
 *
 * Asked about the REAL `createStudioAgent` rather than a stand-in, which is the
 * bug `resolveEvalMode`'s own `overrides` parameter was added for: a gate that
 * reads a different definition than the run announces the wrong mode while
 * holding the key the run would have used. `createStudioAgent` performs no I/O,
 * so a session pointed at a directory that does not exist yet is safe here — and
 * nothing in this def is ever driven.
 */
export function credentialProbe(): ReturnType<typeof createStudioAgent> {
  const session: StudioSession = {
    scope: "eval",
    project: "studio-eval",
    files: {},
    apiKey: "",
    chatToken: "",
    system: STUDIO_EVAL_PROMPT,
    model: studioEvalModel(),
    maxSteps: DEFAULT_STUDIO_EVAL_STEPS,
    dir: path.join(process.cwd(), "does-not-exist"),
  };
  return createStudioAgent(session, {
    ...studioBundleAccess({
      agent: null,
      createRuntime: null,
      env: Object.freeze({}),
      runtime: null,
      activeSessions: 0,
      studio: null,
    }),
    typecheck: () => Promise.resolve({ ok: true, skipped: true }),
  });
}

/**
 * Declare the coding agent's eval suite.
 *
 * Shaped like `describeEval` on purpose — one `describe`, a `test` handed to the
 * definer, per-case setup and teardown owned here — so a reader who has read a
 * template's `agent.eval.test.ts` has read this. The differences are the two the
 * mode forces: the context carries a `chat` rather than a `session` (a text agent
 * has none), and it also carries the workspace, because for this agent the
 * workspace is half the observable behaviour.
 */
export function describeStudioEval(define: (test: StudioEvalTest) => void): void {
  const probe = credentialProbe();
  const { mode, reason } = resolveEvalMode(probe, process.env);
  sayFromHarness(
    mode === "live"
      ? `eval: the studio coding agent on ${studioEvalModel()} — LIVE model (${reason}). ` +
          "This spends tokens, builds workspaces and spawns compilers."
      : `eval: the studio coding agent — SCRIPTED model (${reason}). This checks the ` +
          "wiring and the tools' own answers, not the agent's behaviour.",
  );
  sayFromHarness(
    "eval: cases default to the HARNESS system prompt and say nothing about the " +
      "studio's; a case that passes `studioPrompt` runs the shipped one from " +
      "packages/aai-guest/studio-prompts/ (kept current by `check:studio-prompt`).",
  );

  describe("the studio coding agent", () => {
    let channel: FakeHostChannel | null = null;

    beforeEach(() => {
      // `read_logs` asks the HOST, so the channel has to exist or the tool
      // rejects with a transport error a case would read as a refusal. Answers
      // `{}` and records: what a case can assert is that the tool was reached,
      // never what the platform would have said.
      channel = installFakeHostChannel({ autoAnswer: true });
    });
    afterEach(() => {
      channel = null;
      setHostSend(null);
    });

    const evalTest: StudioEvalTest = (name, body, options) => {
      const skipped =
        (mode === "stub" && options?.live === true) ||
        (mode === "live" && options?.scripted === true);
      const run = skipped ? test.skip : test;
      run(name, () => runStudioCase({ mode, options, body, hostChannel: () => channel }));
    };
    define(evalTest);
  });
}

/** What one case needs to stand itself up. */
type StudioCaseRun = {
  readonly mode: EvalMode;
  readonly options: StudioEvalCaseOptions | undefined;
  readonly body: (ctx: StudioEvalContext) => Promise<void>;
  readonly hostChannel: () => FakeHostChannel | null;
};

/** The `fetch` a case gets unless it asked for a real one. */
export const refusingFetch: typeof globalThis.fetch = (input) =>
  Promise.reject(
    new Error(
      `this eval's fetch refuses the network by default (${String(
        input instanceof Request ? input.url : input,
      )}) — pass \`fetch\` in the case options to grade a web builtin`,
    ),
  );

/**
 * Open everything one case needs, run its body, and close in reverse.
 *
 * Its own function for the reason `describeEval`'s `runCase` is: the teardown is
 * what is worth reading as one unit. The stub model is a PROCESS-GLOBAL kind
 * registration and the conversation owns a live agent, so the `finally` is the
 * only thing that gives either back — and a case that throws must not orphan a
 * kind for the worker's life, which `AAI_EVAL_REPEAT` would otherwise compound.
 */
async function runStudioCase(run: StudioCaseRun): Promise<void> {
  const { mode, options, body } = run;
  const stub = mode === "stub" ? installStubLlm(options?.stubReply ?? STUB_FALLBACK) : undefined;
  try {
    // The production install path, not a bespoke materialize: it is what
    // completes the tree into a real project, reifies whatever package.json
    // declares, and appends the guest's own `toolchainPromptSection()` to the
    // prompt. A case that skipped it would type-check a workspace with no
    // tsconfig and read the failure as the agent's.
    const session = await initStudioSession({
      scope: "eval",
      project: "studio-eval",
      files: options?.files ?? {},
      // The caller's key IS the LLM credential in production, and the split is
      // reproduced rather than papered over: it reaches the model as
      // `providerEnv` and never as `ctx.env`.
      apiKey: process.env[ASSEMBLYAI_LLM_API_KEY_ENV] ?? "",
      chatToken: "eval-chat-token",
      // The shipped prompt when the case asked for one, and the thin harness
      // constant otherwise. `shippedStudioPrompt` THROWS on a missing copy
      // rather than falling back — a case that asked for the studio's prompt
      // and quietly got the harness's is the one failure worth more than the
      // case itself.
      system:
        options?.studioPrompt === undefined
          ? STUDIO_EVAL_PROMPT
          : shippedStudioPrompt(options.studioPrompt),
      model: studioEvalModel(),
      maxSteps: options?.maxSteps ?? DEFAULT_STUDIO_EVAL_STEPS,
    });
    const state = {
      agent: null,
      createRuntime: null,
      env: Object.freeze({}),
      runtime: null,
      activeSessions: 0,
      studio: session,
    };
    const chat = await openEvalTextAgent({
      agent: createStudioAgent(session, {
        // The real loader and the real trial executor — the same pair
        // `harness.ts` builds for the chat surface, so `test_agent` really
        // builds, really loads and really trials.
        ...studioBundleAccess(state),
        // The real compiler, which is what makes the post-write diagnostics a
        // measurement rather than a shape.
        typecheck: () => typecheckWorkspaceDir(session.dir),
      }),
      // Empty, exactly as `studio/chat.ts` passes it: the coding agent's tools
      // have no business reading a credential.
      env: {},
      providerEnv: {
        [ASSEMBLYAI_LLM_API_KEY_ENV]: session.apiKey,
        ...(stub?.env ?? {}),
      },
      ...omitUndefined({ llm: stub?.llm }),
      fetch: options?.fetch ?? refusingFetch,
      // The studio's own per-call deadline and its HARD wall-clock turn budget,
      // rather than the harness defaults — these tools install packages and
      // spawn compilers, and a 30s/90s pair would measure the deadline.
      toolTimeoutMs: STUDIO_TOOL_TIMEOUT_MS,
      turnTimeoutMs: HARD_TURN_MS,
    });
    try {
      await body({
        chat,
        dir: session.dir,
        mode,
        hostCalls: () =>
          (run.hostChannel()?.sent ?? []).flatMap((msg) =>
            "method" in msg && "id" in msg ? [{ method: msg.method, params: msg.params }] : [],
          ),
        read: (rel) => readWorkspaceText(session.dir, rel),
        exists: (rel) => pathExists(path.join(session.dir, rel)),
        typecheck: () => typecheckWorkspaceDir(session.dir),
        runTests: () => runWorkspaceTests(session.dir),
        templateFile: (template, rel) => readTemplateText(template, rel),
      });
    } finally {
      await chat.close();
    }
  } finally {
    stub?.release();
  }
}

/**
 * What a SCRIPTED run does when a case scripted nothing.
 *
 * A line rather than a tool call, and it is not laziness: a script that acted
 * would act on whatever workspace the case set up, and a default that edits
 * files is a default that can break the case declaring it. A case whose stub run
 * should do something says so.
 */
const STUB_FALLBACK = "This is a scripted reply from the studio eval stub model.";

/** A workspace file, or null — never a throw a case would read as a finding. */
async function readWorkspaceText(dir: string, rel: string): Promise<string | null> {
  try {
    return await readFile(path.join(dir, rel), "utf-8");
  } catch {
    return null;
  }
}

async function pathExists(abs: string): Promise<boolean> {
  try {
    await stat(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * A shipped template file from the baked toolchain, or a THROW naming what is
 * missing.
 *
 * Throws rather than answering null on the readers' standing rule: a case
 * comparing against these bytes has nothing to say if it cannot read them, and
 * `expected null to be` is not a report of a missing toolchain.
 */
async function readTemplateText(template: string, rel: string): Promise<string> {
  const root = bundledTemplatesRoot();
  if (root === null) {
    throw new Error("no baked toolchain in this checkout, so no templates to compare against");
  }
  const abs = path.join(root, template, rel);
  try {
    return await readFile(abs, "utf-8");
  } catch (err) {
    throw new Error(`cannot read the shipped ${template}/${rel} at ${abs}`, { cause: err });
  }
}
