// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 3.
 *
 * Epoch 4 is COLLATERAL for the second epoch running, and this file is the
 * evidence that collateral is all it was: **the export list did not change at
 * all** — all 93 names are the same ones epoch 3 promised — and not one helper
 * changed signature. What moved is the declaration they are pointed AT.
 * `AgentDef` gained the endpointing rule table and the two speak-gate windows
 * through `PipelineVoiceTuning`, so `AgentConfigSource` (what
 * `expectDeployable` takes) followed it. Every addition is optional, so a spec
 * that hands `deployedAgent` an agent written before any of them existed still
 * compiles, and so does one that reads `expectDeployable`'s answer field by
 * field.
 *
 * That is the whole promise — new optional fields on the declaration these
 * helpers describe. If a later epoch makes any of them required, or narrows
 * what `deployedAgent` accepts, this file reddens, which is the signal to DROP
 * the epoch rather than to edit the example.
 *
 * ## Two things about its SHAPE, both imposed rather than chosen
 *
 * **It names every one of epoch 3's 93 exports.** The gate requires it
 * (`api-contracts-gate.test.ts`) and the reason is worth understanding: a
 * fixture that names one signature freezes one signature, while every other
 * name in the epoch compiles because nothing mentions it. So the back half of
 * this file is a roll-call, and the front half is the part written to be read.
 * It is the longest roll-call in the tree because this is the widest
 * capability — one promise across `/testing` and `/testing/vitest`.
 *
 * **Its specifiers are RELATIVE.** The same gate insists, and rightly:
 * importing the package by name would resolve through its own `exports` map to
 * whatever the current build publishes, so the fixture would prove the CURRENT
 * surface compiles rather than that epoch 3's does.
 *
 * @module
 */

import { z } from "zod";

import type { Message } from "../../../index.ts";
import { agent, tool } from "../../../index.ts";
import type {
  ProjectFiles,
  RecordedSleep,
  RecordedStep,
  RunSnapshotOverrides,
  ScriptedToolContext,
  ScriptedToolContextOptions,
  SentEvent,
  StepRoute,
  StepUnmatched,
  StubDelegate,
  StubDelegateCall,
  StubDelegateReply,
  StubDelegateRoute,
  StubEmitted,
  StubGateway,
  StubGatewayCall,
  StubGatewayOptions,
  StubGatewayRoute,
  StubGenerate,
  StubGenerateCall,
  StubGenerateReply,
  StubGenerateRoute,
  StubGenerateRoutes,
  StubGenerateScript,
  StubReporter,
  StubSpeech,
  StubSpeechCall,
  StubSpeechOptions,
  StubStepAnswer,
  StubStepDelegate,
  StubStepFetch,
  StubStepRequest,
  StubTranscribe,
  StubTranscribeCall,
  StubTranscribeFailure,
  StubTranscribeLeg,
  StubTranscribeOptions,
  StubUpload,
  StubUploads,
  StubUploadsOptions,
  StubUploadWrite,
  TestToolContext,
  ToolBearingAgent,
  ToolContextOverrides,
  ToolRunner,
  WorkflowContextOptions,
  WorkflowContextRecorder,
} from "../../../sdk/testing-barrel.ts";
import {
  commandedBuiltins,
  createProgressStream,
  createRunSnapshot,
  createStubWorkflows,
  createToolContext,
  createWorkflowContext,
  deployedAgent,
  dialogRefusalPattern,
  dialogResultSchema,
  expectDeployable,
  expectDialogOk,
  expectDialogRefused,
  expectPromptBuiltinsDeclared,
  expectToolOk,
  parseSchemaInput,
  parseToolInput,
  routeStepFetch,
  runGuardrail,
  runTool,
  STUB_SPEECH_PCM_BYTES,
  schemaInputIssues,
  scriptedToolContext,
  stubDelegate,
  stubGateway,
  stubGatewayRoute,
  stubGenerate,
  stubReporter,
  stubSpeech,
  stubStepDelegate,
  stubStepFetch,
  stubStepInfo,
  stubTranscribe,
  stubUploads,
  toolInputIssues,
  toolOf,
  toolRunner,
  WORKFLOW_CONTEXT_NOW,
} from "../../../sdk/testing-barrel.ts";
import type { StubWorkflowsOptions } from "../../../sdk/testing-vitest-barrel.ts";
import {
  installStubGateway,
  installStubReporter,
  installStubSpeech,
  installStubStepDelegate,
  installStubStepFetch,
  installStubTranscribe,
  installStubUploads,
  installStubWorkflows,
} from "../../../sdk/testing-vitest-barrel.ts";

// ─── The project under test ──────────────────────────────────────────────────

const quoteSchema = z.object({ sku: z.string(), qty: z.number().int().positive() });

const quote = tool({
  description: "Quote a line item.",
  inputSchema: quoteSchema,
  execute: async ({ sku, qty }, ctx) => {
    const blurb = await ctx.generate({ prompt: `One line about ${sku}.` });
    ctx.send("quoted", { sku });
    return { sku, qty, blurb: blurb.text };
  },
});

/**
 * The AUTHORED def: `agent()` refuses an inline `tools` map, so the tools live
 * in files and only `deployedAgent` puts the two halves back together.
 */
const authored = agent({
  name: "Quote desk",
  systemPrompt: "Quote what the caller asks for.",
  greeting: "Quote desk.",
});

const project: ProjectFiles = {
  tools: { "./tools/quote.ts": { default: quote } },
  systemPrompt: "Quote what the caller asks for.",
};

/** What a DEPLOYED agent runs, which is what a spec has to drive. */
const desk = deployedAgent(authored, project);

// ─── What a spec in the author's own project does with it ────────────────────

/** The one-call context: a scripted model, a recording `send`, inert everything else. */
export async function quotesOneLine() {
  const ctx: TestToolContext = createToolContext({
    env: { PRICES_URL: "https://prices.example" },
    generate: "A sturdy blue widget.",
  });
  const result = await runTool(desk, "quote", { sku: "W1", qty: 2 }, ctx);
  // The unwrap that THROWS quoting a refusal, where a cast would read
  // `undefined` off a `ToolFailure` several assertions later.
  const ok = expectToolOk<{ sku: string; blurb: string }>(result);
  const sent: readonly SentEvent[] = ctx.sent;
  const asked: StubGenerate = ctx.model;
  return { ok, sent, calls: asked.calls.length };
}

/** `ctx.messages` seeded by hand — two-key `Message` literals, and no more. */
export function historyContext(): ToolContextOverrides {
  const messages: readonly Message[] = [
    { role: "user", content: "Two blue widgets please." },
    { role: "assistant", content: "Quoting those now." },
  ];
  return { messages, sessionId: "s-1" };
}

/** Asking the tool's own schema what it accepts, instead of reaching into `~standard`. */
export async function refusesZeroQty() {
  const good = await parseToolInput<{ sku: string; qty: number }>(desk, "quote", {
    sku: "W1",
    qty: 1,
  });
  const issues = await toolInputIssues(desk, "quote", { sku: "W1", qty: 0 });
  const bySchema = await parseSchemaInput(quoteSchema, { sku: "W1", qty: 1 }, "quote input");
  const schemaIssues = await schemaInputIssues(quoteSchema, {}, "quote input");
  return { good, issues, bySchema, schemaIssues };
}

/** The def a DEPLOYED agent runs, when the project's tools are files. */
export function deployedShape() {
  const config = expectDeployable(desk);
  return {
    builtins: commandedBuiltins(config),
    declared: expectPromptBuiltinsDeclared(desk),
    named: toolOf(desk, "quote").description,
    run: toolRunner(desk),
  };
}

// ─── The fakes a collaborator is driven by ───────────────────────────────────

/** Built and restored by hand — the `/testing` half. */
export function handRolledFakes() {
  const uploads: StubUploads = stubUploads({ "u-1": new Uint8Array([1, 2, 3]) });
  const gateway: StubGateway = stubGateway(["ok"], { status: 200 });
  const speech: StubSpeech = stubSpeech({ pcmBytes: STUB_SPEECH_PCM_BYTES });
  const transcribe: StubTranscribe = stubTranscribe({ text: "two blue widgets" });
  const reporter: StubReporter = stubReporter();
  const fetching: StubStepFetch = stubStepFetch(() => ({ status: 200, body: "{}" }));
  const desks: StubStepDelegate = stubStepDelegate("done");
  // `stubGateway` is the one that installs nothing — it hands back a `fetch`
  // for the caller to pass on — so it has no `restore` to call.
  const restore = () => {
    for (const fake of [uploads, speech, transcribe, reporter, fetching, desks]) {
      fake.restore();
    }
  };
  return { uploads, gateway, speech, transcribe, reporter, fetching, desks, restore };
}

/** And the `/vitest` half, which is the same five plus `onTestFinished(restore)`. */
export function installedFakes() {
  return {
    uploads: installStubUploads({ "u-1": new Uint8Array([1]) }),
    gateway: installStubGateway("ok"),
    speech: installStubSpeech(),
    transcribe: installStubTranscribe(),
    reporter: installStubReporter(),
    stepFetch: installStubStepFetch(),
    stepDelegate: installStubStepDelegate("done"),
    workflows: installStubWorkflows(),
  };
}

/** A routed model and a routed desk, keyed by what the caller asked for. */
export function scripted(): ScriptedToolContext {
  const model: StubGenerateScript = {
    "One line about W1.": "A sturdy blue widget.",
    default: (call: StubGenerateCall) => `No copy for ${call.prompt}.`,
  };
  const desks: Readonly<Record<string, StubDelegateRoute>> = { researcher: "Nothing found." };
  const options: ScriptedToolContextOptions = { generate: model, delegate: desks };
  return scriptedToolContext(options);
}

// ── The rest of epoch 3's promised surface.
//
//    The example above pins the SHAPES the transition touched; these are the
//    names it promised and did not reach. Named here because a retained epoch
//    is a promise about all of it, and a fixture that names one signature
//    freezes one signature (`api-contracts-gate.test.ts`).

export type Epoch3Types = {
  projectFiles: ProjectFiles;
  recordedSleep: RecordedSleep;
  recordedStep: RecordedStep;
  runSnapshotOverrides: RunSnapshotOverrides;
  scriptedToolContext: ScriptedToolContext;
  scriptedToolContextOptions: ScriptedToolContextOptions;
  sentEvent: SentEvent;
  stepRoute: StepRoute;
  stepUnmatched: StepUnmatched;
  stubDelegate: StubDelegate;
  stubDelegateCall: StubDelegateCall;
  stubDelegateReply: StubDelegateReply;
  stubDelegateRoute: StubDelegateRoute;
  stubEmitted: StubEmitted;
  stubGateway: StubGateway;
  stubGatewayCall: StubGatewayCall;
  stubGatewayOptions: StubGatewayOptions;
  stubGatewayRoute: StubGatewayRoute;
  stubGenerate: StubGenerate;
  stubGenerateCall: StubGenerateCall;
  stubGenerateReply: StubGenerateReply;
  stubGenerateRoute: StubGenerateRoute;
  stubGenerateRoutes: StubGenerateRoutes;
  stubGenerateScript: StubGenerateScript;
  stubReporter: StubReporter;
  stubSpeech: StubSpeech;
  stubSpeechCall: StubSpeechCall;
  stubSpeechOptions: StubSpeechOptions;
  stubStepAnswer: StubStepAnswer;
  stubStepDelegate: StubStepDelegate;
  stubStepFetch: StubStepFetch;
  stubStepRequest: StubStepRequest;
  stubTranscribe: StubTranscribe;
  stubTranscribeCall: StubTranscribeCall;
  stubTranscribeFailure: StubTranscribeFailure;
  stubTranscribeLeg: StubTranscribeLeg;
  stubTranscribeOptions: StubTranscribeOptions;
  stubUpload: StubUpload;
  stubUploadWrite: StubUploadWrite;
  stubUploads: StubUploads;
  stubUploadsOptions: StubUploadsOptions;
  stubWorkflowsOptions: StubWorkflowsOptions;
  testToolContext: TestToolContext;
  toolBearingAgent: ToolBearingAgent;
  toolContextOverrides: ToolContextOverrides;
  toolRunner: ToolRunner;
  workflowContextOptions: WorkflowContextOptions;
  workflowContextRecorder: WorkflowContextRecorder;
};

export const epoch3Values = [
  STUB_SPEECH_PCM_BYTES,
  WORKFLOW_CONTEXT_NOW,
  commandedBuiltins,
  createProgressStream,
  createRunSnapshot,
  createStubWorkflows,
  createToolContext,
  createWorkflowContext,
  deployedAgent,
  dialogRefusalPattern,
  dialogResultSchema,
  expectDeployable,
  expectDialogOk,
  expectDialogRefused,
  expectPromptBuiltinsDeclared,
  expectToolOk,
  installStubGateway,
  installStubReporter,
  installStubSpeech,
  installStubStepDelegate,
  installStubStepFetch,
  installStubTranscribe,
  installStubUploads,
  installStubWorkflows,
  parseSchemaInput,
  parseToolInput,
  routeStepFetch,
  runGuardrail,
  runTool,
  schemaInputIssues,
  scriptedToolContext,
  stubDelegate,
  stubGateway,
  stubGatewayRoute,
  stubGenerate,
  stubReporter,
  stubSpeech,
  stubStepDelegate,
  stubStepFetch,
  stubStepInfo,
  stubTranscribe,
  stubUploads,
  toolInputIssues,
  toolOf,
  toolRunner,
] as const;
