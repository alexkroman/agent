// Copyright 2025 the AAI authors. MIT license.
/**
 * Frozen template: `aai-runtime:eval` epoch 1.
 *
 * An eval suite as it was written against epoch 1: the three `describe*Eval`
 * drivers with their case options, the three `openEval*` handles for a spec
 * that drives one by hand, the runtime's own stubs (model, speech, `run_code`),
 * and the credential readers that decide live versus scripted. It must keep
 * compiling against current source for as long as epoch 1 is advertised as
 * supported.
 *
 * What epoch 2 moved, and why this file still compiles: `call` on
 * `EvalSessionOptions`, `EvalCaseOptions` and `DescribeEvalOptions` takes
 * `SessionCallInput` — the carrier, call id and parameters a case hands in,
 * which is everything `SessionCall` was at epoch 1. The probe reports
 * `call.brief` removed because it reads today's `SessionCall` on both sides;
 * the reader did not exist then.
 */

import { agent } from "@alexkroman1/aai";
import {
  createStubSttOpener,
  createStubTtsOpener,
  createVmRunCode,
  DEFAULT_RUN_TIMEOUT_MS,
  type EvalCredentials,
  type EvalEmitted,
  type EvalRunOptions,
  type EvalSession,
  type EvalSessionOptions,
  type EvalSleep,
  type EvalTextAgent,
  type EvalTextAgentOptions,
  type EvalWorkflowRun,
  type EvalWorkflows,
  type EvalWorkflowsOptions,
  evalCredentials,
  evalTextCredentials,
  evalWorkflowCredentials,
  installStubLlm,
  installStubSpeechProviders,
  openEvalSession,
  openEvalTextAgent,
  openEvalWorkflows,
  STUB_LLM_API_KEY_ENV,
  STUB_SPEECH_API_KEY_ENV,
  type StubLlm,
  type StubScript,
  type StubSpeechProviders,
  type StubStep,
  type StubSttSession,
  type StubTtsSession,
  type VmRunCodeOptions,
} from "../../../eval-barrel.ts";
import {
  type DescribeEvalOptions,
  type DescribeTextEvalOptions,
  describeEval,
  describeTextEval,
  describeWorkflowEval,
  type EvalCaseOptions,
  type EvalMode,
  type EvalTest,
  type EvalTestContext,
  type EvalTextTest,
  type EvalTextTestContext,
  type EvalWorkflowCaseOptions,
  type EvalWorkflowTest,
  type EvalWorkflowTestContext,
  resolveEvalMode,
  resolveWorkflowEvalMode,
} from "../../../eval-vitest-barrel.ts";

// --- The agent, and the call its sessions arrive on ------------------------------

const frontDesk = agent({ name: "Front desk", systemPrompt: "You answer the phone." });
const call = { carrier: "twilio", callId: "CA123", parameters: { campaign: "spring" } };

// --- The voice suite --------------------------------------------------------------

const caseOptions: EvalCaseOptions = {
  stubReply: "Welcome back.",
  call,
  phone: "+15550100",
  clientId: "device-1",
  live: false,
};

export function voiceSuite(): void {
  const define = (evalCase: EvalTest): void => {
    evalCase(
      "greets a returning caller",
      async (ctx: EvalTestContext) => {
        const session: EvalSession = ctx.session;
        const mode: EvalMode = ctx.mode;
        const turn = await session.say("Hi, it's me again.");
        if (mode === "stub" && !turn.text.includes("Welcome")) throw new Error(turn.text);
      },
      caseOptions,
    );
  };
  describeEval(frontDesk, define, { call, phone: "+15550100", turnTimeoutMs: 20_000 });
}

const suite: DescribeEvalOptions = { call, phone: "+15550100", turnTimeoutMs: 20_000 };
const sessionOptions: EvalSessionOptions = { agent: frontDesk, ...suite };

export async function openOnce(): Promise<readonly string[]> {
  const session = await openEvalSession(sessionOptions);
  await session.sayAll(["Hi.", "Book me in."]);
  const said = session.said();
  if (session.toolCalls().length > session.events().length) throw new Error("impossible");
  await session.close();
  return said;
}

// --- The text suite ---------------------------------------------------------------

const describeText: DescribeTextEvalOptions = { turnTimeoutMs: 10_000 };
const textOptions: EvalTextAgentOptions = { agent: frontDesk, ...describeText };

export function textSuite(): void {
  const define = (evalCase: EvalTextTest): void => {
    evalCase("answers in text", async (ctx: EvalTextTestContext) => {
      const chat: EvalTextAgent = ctx.agent;
      const turn = await chat.send("hi");
      if (turn.text.length === 0) throw new Error("silent");
    });
  };
  describeTextEval(frontDesk, define, describeText);
}

export async function textOnce(): Promise<readonly string[]> {
  const chat = await openEvalTextAgent(textOptions);
  await chat.sendAll(["Hi.", "Thanks."]);
  const said = chat.said();
  if (chat.toolCalls().length > chat.events().length) throw new Error("impossible");
  await chat.close();
  return said;
}

// --- The workflow suite -----------------------------------------------------------

const runOptions: EvalRunOptions = { key: "u1", timeoutMs: 5000 };
const workflowCase: EvalWorkflowCaseOptions = { live: false };
const workflowOptions: EvalWorkflowsOptions = {
  agent: frontDesk,
  timeoutMs: DEFAULT_RUN_TIMEOUT_MS,
};

export function workflowSuite(): void {
  const define = (evalCase: EvalWorkflowTest): void => {
    evalCase(
      "audits an upload",
      async (ctx: EvalWorkflowTestContext) => {
        const app: EvalWorkflows = ctx.app;
        const run: EvalWorkflowRun = await app.run("audit", { uploadId: "u1" }, runOptions);
        const slept: readonly EvalSleep[] = run.slept;
        const emitted: readonly EvalEmitted[] = run.emitted;
        if (!run.completed || slept.length + emitted.length < 0) throw new Error(run.error ?? "?");
        await app.settleAll();
      },
      workflowCase,
    );
  };
  describeWorkflowEval(frontDesk, define, { timeoutMs: DEFAULT_RUN_TIMEOUT_MS });
}

export function workflowsOnce(): EvalWorkflows {
  return openEvalWorkflows(workflowOptions);
}

// --- The runtime's own stubs --------------------------------------------------------

const step: StubStep = { tool: "look_up_order", args: { orderId: "A1" } };
const script: StubScript = ["Welcome.", step, { text: "Found it." }];

export function stubs(): string[] {
  const llm: StubLlm = installStubLlm(script);
  const speech: StubSpeechProviders = installStubSpeechProviders();
  const stt: StubSttSession | undefined = speech.sttSession();
  const tts: StubTtsSession | undefined = speech.ttsSession();
  const sttOpener = createStubSttOpener("stt");
  const ttsOpener = createStubTtsOpener("tts");
  const vm: VmRunCodeOptions = { timeoutMs: 1000, globals: { answer: 42 } };
  const runCode = createVmRunCode(vm);
  llm.release();
  speech.release();
  return [
    llm.env[STUB_LLM_API_KEY_ENV] ?? "",
    speech.env[STUB_SPEECH_API_KEY_ENV] ?? "",
    stt === undefined ? "" : "stt",
    tts === undefined ? "" : "tts",
    typeof sttOpener,
    typeof ttsOpener,
    typeof runCode,
  ];
}

// --- Live or scripted -----------------------------------------------------------------

export function credentials(): { modes: EvalMode[]; ready: boolean } {
  const voice = resolveEvalMode(frontDesk, process.env);
  const workflow = resolveWorkflowEvalMode(frontDesk, process.env);
  const all: EvalCredentials[] = [
    evalCredentials(frontDesk, process.env),
    evalTextCredentials(frontDesk),
    evalWorkflowCredentials(frontDesk),
  ];
  return { modes: [voice.mode, workflow.mode], ready: all.every((one) => one.ready) };
}
