// Copyright 2026 the AAI authors. MIT license.
/**
 * The vitest-coupled half of the test helpers (`@alexkroman1/aai/testing/vitest`).
 *
 * `sdk/testing.ts` is framework-agnostic on purpose — it returns fakes rather
 * than installing them, so it carries no test-runner dependency and a project
 * using another runner can still build a `ToolContext`. That is the right
 * default and it is not free: `stubGateway` (`@alexkroman1/aai/testing`)
 * hands back a `fetch`
 * implementation, and the INSTALLATION of it was then written out by hand in
 * every workflow template, four times, each with the same paragraph explaining
 * why the SDK had not done it.
 *
 * So the coupling gets its own subpath instead of leaking into the main one.
 * `vitest` is an OPTIONAL peer dependency: importing this module is what pulls
 * it, importing `@alexkroman1/aai/testing` is not, and a project that never
 * writes a test resolves neither.
 *
 * **The rule for what belongs here: anything that installs, and anything that
 * restores.** Every fake on `@alexkroman1/aai/testing` that fills a published
 * slot hands back a `restore` the caller owns, and owning it means a registry —
 * `const restores: (() => void)[]` with an `afterEach` that splices it, written
 * out in template after template, three times in one file. The `install*` half
 * of this module is that fake plus `onTestFinished(restore)`: same object,
 * unwound by the runner in reverse order when the test that installed it ends.
 *
 * A fake with no lifetime (`stubGenerate`, `createToolContext`, the workflow
 * snapshots) gets no wrapper — there is nothing to restore, so a second name
 * for it would only be a second name.
 *
 * **`installStubWorkflows` is here for the other half of the same rule: `vi.fn` IS its
 * content.** It restores nothing and installs nothing, so it takes no `install`
 * prefix — but its methods have to be spies, because a spec of a
 * workflow-driving tool asserts on `start` and re-points `lastLine` per test.
 * A plain-function version would be a helper neither caller could use, so the
 * coupling is the feature rather than a leak.
 *
 * @module testing/vitest
 */

// Each `install*` registers its `restore` with `onTestFinished`, not `afterEach`:
// `afterEach` may only be called while a suite is COLLECTED, so a helper called
// from a test body could not register one. Outside a test or hook vitest throws;
// a fake with module lifetime uses `@alexkroman1/aai/testing`'s `restore` form.
import { describe, onTestFinished, test, vi } from "vitest";
import type { StubStepAnswer, StubStepFetch, StubStepRequest } from "./_testing-step-fetch.ts";
import { stubStepFetch } from "./_testing-step-fetch.ts";
import type {
  StubTranscribe,
  StubTranscribeCall,
  StubTranscribeOptions,
} from "./_testing-transcribe.ts";
import { stubTranscribe } from "./_testing-transcribe.ts";
import { ASSEMBLYAI_API_KEY_ENV } from "./constants.ts";
import { hasStepReporter } from "./step-report.ts";
import type { StubReporter } from "./testing.ts";
import { stubReporter } from "./testing.ts";
import type { StubClientInbox, StubClientInboxOptions } from "./testing-client-inbox.ts";
import { stubClientInbox } from "./testing-client-inbox.ts";
import type { StubDelegateScript, StubStepDelegate } from "./testing-delegate.ts";
import { stubStepDelegate } from "./testing-delegate.ts";
import { expectDeployable } from "./testing-deployable.ts";
import {
  type FetchRouteHandler,
  type FetchRouteTable,
  routeOf,
  toRouteRequest,
} from "./testing-fetch-routes.ts";
import type { StubGatewayCall, StubGatewayOptions } from "./testing-gateway.ts";
import { stubGateway, stubGatewayRoute } from "./testing-gateway.ts";
import type { StubSpeech, StubSpeechCall, StubSpeechOptions } from "./testing-speech.ts";
import { stubSpeech } from "./testing-speech.ts";
import { type ToolBearingAgent, type ToolRunner, toolRunner } from "./testing-tools.ts";
import type { StubUpload, StubUploads, StubUploadsOptions } from "./testing-uploads.ts";
import { stubUploads } from "./testing-uploads.ts";
import { createStubWorkflows } from "./testing-workflows.ts";
import type { WorkflowClient } from "./workflow-client.ts";
import type { WorkflowAppLike } from "./workflow-readings.ts";
import type { WorkflowRunSnapshot } from "./workflow-run.ts";

/**
 * The credential a step reads for the AssemblyAI gateway (`requireStepEnv` in
 * `stepGenerate`), and the one every installer here seeds by default — the
 * SDK's one spelling of the name (`constants.ts`).
 */
const API_KEY_ENV = ASSEMBLYAI_API_KEY_ENV;
/** What the seeded key holds: recognizable, and good for nothing real. */
const STUB_API_KEY = "sk-aai-stub";

/**
 * Seed `ASSEMBLYAI_API_KEY` for this test when the process holds none, and put
 * the previous value back when the test finishes.
 *
 * `stepGenerate` reads the key through `stepEnv`, which falls back to
 * `process.env` in a process where no host has published one — which is what a
 * spec is — and REFUSES by name when it is missing. So every spec of a step
 * that calls the gateway opened with `vi.stubEnv("ASSEMBLYAI_API_KEY", …)`
 * before installing the fake that never looks at it; one shipped template's
 * `beforeEach` exists for this line alone. Seeded only when ABSENT, so a spec
 * that set its own value (to assert the `Bearer` header, say) keeps it.
 *
 * Restored explicitly, not only by `unstubEnvs`: a project on
 * `defineAgentTestConfig` has that set, but a hand-written config may not, and
 * a key left seeded would outlive the test that asked for it. `vi.stubEnv` with
 * the previous value (or `undefined`) is the sanctioned restore — never
 * `delete process.env.X`.
 */
function seedApiKey(apiKey: string | false | undefined): void {
  if (apiKey === false) return;
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const previous = env?.[API_KEY_ENV];
  if (apiKey === undefined && previous !== undefined && previous !== "") return;
  vi.stubEnv(API_KEY_ENV, apiKey ?? STUB_API_KEY);
  onTestFinished(() => {
    vi.stubEnv(API_KEY_ENV, previous);
  });
}

/**
 * Options for {@link installStubGateway}: `stubGateway`'s, plus the credential.
 *
 * @input
 * @public
 */
export type InstallStubGatewayOptions = StubGatewayOptions & {
  /**
   * The `ASSEMBLYAI_API_KEY` to seed for this test, when the process holds
   * none — see {@link installStubWorld}. Defaults to a recognizable stub
   * value; `false` seeds nothing, for the one spec whose subject IS the
   * missing-key refusal.
   */
  apiKey?: string | false | undefined;
};

/**
 * Install a fake LLM gateway as the global `fetch`, and return its call log.
 *
 * `stubGateway` (`@alexkroman1/aai/testing`) installed for you. Import it under
 * THIS name — aliasing it to `stubGateway` shadows the uninstalled fake of that
 * name. A step whose HTTP goes through a published `stepFetch` wants
 * `stubGatewayRoute` instead; `stubGateway`'s doc has the table.
 *
 * The calls array is what a spec asserts on, and it is live — a reference taken
 * before the code under test runs holds every call made after.
 *
 * **Lifetime is one test**, as it is for any `vi.stubGlobal` under
 * `unstubGlobals` — which this repo's shared config and `defineAgentTestConfig`
 * (`@alexkroman1/aai/testing/vite`) both set, so the real `fetch` is back
 * before the next test. Install per test (the test body or a `beforeEach`);
 * one installed in `beforeAll` is gone before the first test runs. Without
 * `unstubGlobals`, `vi.unstubAllGlobals()` is the explicit undo.
 *
 * **It also seeds `ASSEMBLYAI_API_KEY`** for the test when the process holds
 * none, since `stepGenerate` refuses by name without one and the fake never
 * reads it — `apiKey: false` opts out. The seed is put back when the test
 * finishes.
 *
 * @param replies - Completion contents, in order; the last repeats — see
 *   `stubGateway` in `@alexkroman1/aai/testing`, which this installs.
 *
 * @example
 * ```ts no-check
 * // `no-check`: the step under test is in another file, which is the point.
 * import { installStubGateway } from "@alexkroman1/aai/testing/vitest";
 * import { expect, test } from "vitest";
 * import { summarize } from "./workflows/digest.ts";
 *
 * test("summarize sends the article", async () => {
 *   const calls = installStubGateway('{"headline":"Otters use tools"}');
 *   await summarize("Otters use tools.");
 *   expect(calls[0]?.prompt).toContain("Otters use tools.");
 * });
 * ```
 *
 * @public
 */
export function installStubGateway(
  replies: string | readonly string[],
  options: InstallStubGatewayOptions = {},
): StubGatewayCall[] {
  const { apiKey, ...gatewayOptions } = options;
  seedApiKey(apiKey);
  const gateway = stubGateway(replies, gatewayOptions);
  vi.stubGlobal("fetch", gateway.fetch);
  return gateway.calls;
}

/**
 * Publish an in-memory upload store, restored when this test finishes.
 *
 * `stubUploads` with the bookkeeping done — see it for what the store
 * serves, why writes are opt-in, and why the minted ids count up.
 *
 * @example
 * ```ts no-check
 * import { installStubUploads } from "@alexkroman1/aai/testing/vitest";
 *
 * test("the step reads the recording it was given", async () => {
 *   const uploads = installStubUploads({ upl_1: new Uint8Array(5000) }, { writable: true });
 *   await ingest("upl_1");
 *   expect(uploads.writes).toHaveLength(1);
 * });
 * ```
 *
 * @public
 */
export function installStubUploads(
  files: Readonly<Record<string, StubUpload>>,
  options: StubUploadsOptions = {},
): StubUploads {
  const uploads = stubUploads(files, options);
  onTestFinished(uploads.restore);
  return uploads;
}

/**
 * Publish a fake `stepFetch`, restored when this test finishes.
 *
 * `stubStepFetch` with the bookkeeping done — see it for why a step's HTTP
 * goes through a published slot rather than the global, and what the recorded
 * request carries.
 *
 * @param answer - Called per request. Defaults to an empty `200`.
 *
 * @public
 */
export function installStubStepFetch(
  answer?: (request: StubStepRequest) => StubStepAnswer | Promise<StubStepAnswer>,
): StubStepFetch {
  const fetched = answer ? stubStepFetch(answer) : stubStepFetch();
  onTestFinished(fetched.restore);
  return fetched;
}

/**
 * Capture what a step narrates and emits, restored when this
 * test finishes.
 *
 * `stubReporter` with the bookkeeping done — see it for why `stepReport()` and
 * `stepEmit()` are separated the way the streams are.
 *
 * @public
 */
export function installStubReporter(): StubReporter {
  const reported = stubReporter();
  onTestFinished(reported.restore);
  return reported;
}

/**
 * Publish a fake subagent runner for `stepDelegate`, restored when this test
 * finishes.
 *
 * `stubStepDelegate` with the bookkeeping done. It is the only way to drive an
 * exported step that delegates — the real slot THROWS when nothing has published,
 * deliberately, because there is no degraded version of running a model loop.
 *
 * @public
 */
export function installStubStepDelegate(script: StubDelegateScript): StubStepDelegate {
  const delegated = stubStepDelegate(script);
  onTestFinished(delegated.restore);
  return delegated;
}

/**
 * Publish a synthesizer that records what it was asked to say, restored when
 * this test finishes.
 *
 * `stubSpeech` with the bookkeeping done — see it for the call log's
 * shape, the silence it answers with, and how to make it fail instead.
 *
 * @public
 */
export function installStubSpeech(options: StubSpeechOptions = {}): StubSpeech {
  const speech = stubSpeech(options);
  onTestFinished(speech.restore);
  return speech;
}

/**
 * Publish a device inbox for `stepNotifyClient`, restored when this test
 * finishes.
 *
 * `stubClientInbox` with the bookkeeping done — see it for the call log and how
 * to make the device answer busy or offline. The usual partner of
 * {@link installStubSpeech}: a step that speaks a notice and pushes it to a
 * speaker needs both, and each used to cost a `try`/`finally` of its own.
 *
 * @example
 * In a test body or a `beforeEach`:
 * ```ts
 * import { stepNotifyClient } from "@alexkroman1/aai/step";
 * import { installStubClientInbox } from "@alexkroman1/aai/testing/vitest";
 *
 * const inbox = installStubClientInbox();
 * await stepNotifyClient("kitchen", { id: "wrun_1", event: "reminder" });
 * console.log(inbox.calls[0]?.clientId); // "kitchen"
 * ```
 *
 * @public
 */
export function installStubClientInbox(options: StubClientInboxOptions = {}): StubClientInbox {
  const inbox = stubClientInbox(options);
  onTestFinished(inbox.restore);
  return inbox;
}

/**
 * Answer AssemblyAI's transcription endpoints in memory, restored when this test
 * finishes.
 *
 * `stubTranscribe` with the bookkeeping done — see it for the four legs it
 * routes, why a refusal is staged as an HTTP status rather than as a
 * `TranscribeError`, and why it takes an `otherwise` handler.
 *
 * @public
 */
export function installStubTranscribe(options: StubTranscribeOptions = {}): StubTranscribe {
  const provider = stubTranscribe(options);
  onTestFinished(provider.restore);
  return provider;
}

/**
 * What {@link installStubWorkflows} answers each read with.
 *
 * Every field has a default, so `installStubWorkflows()` is a client whose reads all
 * answer "nothing has run" — which is the arm a `*_status` tool branches on
 * first and the one most specs of one want.
 *
 * @input
 * @public
 */
export type StubWorkflowsOptions = {
  /**
   * The runs `get`, `find` and `recent` answer from — `get` with the first,
   * the other two with the whole list. One list rather than three, because a
   * spec asserting what a tool REPORTS is describing one world, and three
   * fixtures that can disagree about it is a way to write a passing test for a
   * state the platform cannot produce. Build them with `createRunSnapshot`.
   */
  runs?: readonly WorkflowRunSnapshot[];
  /**
   * Workflow names `listing()` reports, in order — normally the one the agent
   * under test declares. Defaults to the keys of {@link StubWorkflowsOptions.agent}'s
   * `workflows`, else none, i.e. an agent declaring no workflow.
   */
  names?: readonly string[];
  /**
   * The agent under test, whose declared `workflows` are what `listing()`
   * reports — so a renamed workflow is read off the def rather than restated.
   * Pass `agentDef`; an explicit `names` wins over it.
   */
  agent?: WorkflowAppLike | undefined;
  /** What `start` resolves with. Defaults to `"wrun_stub"`. */
  runId?: string;
  /**
   * What `lastLine` resolves with. Defaults to `undefined`, which means "the
   * run has written nothing yet" — the arm a progress tool branches on, and the
   * reason this has a default rather than being left to reject.
   */
  lastLine?: unknown;
};

/**
 * A `ctx.workflows` whose reads answer from one fixture and whose every method
 * is a `vi.fn`.
 *
 * `createStubWorkflows` (`@alexkroman1/aai/testing`) is the framework-agnostic
 * base: it REJECTS every method, so a tool reaching for one the spec did not
 * stub says so. That is the right default and it is not the shape a spec of a
 * workflow-driving agent wants, because such a tool reads two or three methods
 * per call and asserts on `start`. Both shipped workflow templates therefore
 * opened with the same fifteen lines — a `vi.fn` per method, answering from one
 * `runs` array — byte-identical apart from the workflow name in `listing`.
 *
 * **It is on this subpath because `vi.fn` is the content.** The methods have to
 * be spies: a spec asserts `expect(workflows.start).toHaveBeenCalledWith(def,
 * input)` and re-points one per test with
 * `vi.mocked(workflows.lastLine).mockResolvedValue("…")`. A plain-function
 * version would be a different helper that neither template could use.
 *
 * **What it does NOT answer is deliberate.** `stream`, `streamTail`, `signal`
 * and `publicWebhookUrl` fall through to the rejecting base, because a tool
 * reading a progress channel by hand is the hazard `lastLine` exists to remove
 * — see `WorkflowClient.lastLine`, where composing `streamTail` + `stream` in
 * the wrong order waits forever with no error — and `signal` spells a raw
 * token where `signalRun` (answered, `true`) derives it. A spec that really is
 * testing one of those overrides it, which reads as the deliberate act it is.
 *
 * Spread it to replace a method for one test: `{ ...installStubWorkflows(), signal }`.
 *
 * @example
 * ```ts
 * import { createRunSnapshot, createToolContext } from "@alexkroman1/aai/testing";
 * import { installStubWorkflows } from "@alexkroman1/aai/testing/vitest";
 *
 * const workflows = installStubWorkflows({
 *   names: ["recap"],
 *   runs: [createRunSnapshot({ workflow: "recap", status: "running" })],
 * });
 * const ctx = createToolContext({ workflows });
 * ```
 *
 * @public
 */
/** A run that is still going — what `live` answers and `cancelAll` counts. */
function isLive(run: WorkflowRunSnapshot): boolean {
  return run.status === "pending" || run.status === "running";
}

export function installStubWorkflows(options: StubWorkflowsOptions = {}): WorkflowClient {
  const runs = options.runs ?? [];
  const runId = options.runId ?? "wrun_stub";
  const names = options.names ?? Object.keys(options.agent?.workflows ?? {});
  const lastLine = options.lastLine;
  return createStubWorkflows({
    start: vi.fn(async () => runId),
    // The first of the same list the lookups answer from, so "the run this
    // session started" and "this session's runs" cannot disagree.
    get: vi.fn(async () => runs[0]),
    find: vi.fn(async () => [...runs]),
    findByKey: vi.fn(async () => [...runs]),
    recent: vi.fn(async () => [...runs]),
    // The same list read the way the client reads it: `latest` is the first
    // (newest), `live` the first still going.
    latest: vi.fn(async () => runs[0]),
    live: vi.fn(async () => runs.find(isLive)),
    cancel: vi.fn(async () => true),
    // As many as `cancel` would have ended, one by one: the unfinished runs.
    cancelAll: vi.fn(async () => runs.filter(isLive).length),
    // Delivered, as a tool signalling the run it just started expects; a spec
    // asserting the token or payload reads the mock's calls.
    signalRun: vi.fn(async () => true),
    // `0` woken: a `wakeUp` that reports work done is the interesting case and
    // the one a spec overrides, so the default is the quiet answer.
    wakeUp: vi.fn(async () => 0),
    lastLine: vi.fn(async () => lastLine),
    listing: vi.fn(() => names.map((name) => ({ name }))),
  });
}

/**
 * What {@link installStubWorld} may be told: one entry per seam a step reaches
 * through, each optional, each installed only when named.
 *
 * @input
 * @public
 */
export type StubWorldOptions = {
  /**
   * What the LLM gateway answers, in order, the last repeating — `stubGatewayRoute`'s
   * replies. Routed FIRST, on the completions path, before every other leg:
   * a page stub answering the gateway's request with HTML is the footgun this
   * ordering exists for (the summarize step retries six times against it).
   * Absent, a completion request falls through to the other legs.
   */
  readonly model?: string | readonly string[] | undefined;
  /**
   * Answer AssemblyAI's transcription endpoints — `installStubTranscribe`'s
   * options. When present, the transcription fake OWNS the published step
   * fetch and the gateway and `pages` legs are its `otherwise`, which is the
   * only order that works: publishing replaces, so two fakes cannot both hold
   * the slot. An `otherwise` of your own runs after both.
   */
  readonly transcribe?: StubTranscribeOptions | undefined;
  /**
   * Everything else a step fetches — a page, a vendor API — as a
   * `stubFetchRoutes` table, an ordered handler list (what `describeEval`'s
   * `steps.routes` takes too) or one handler. The LAST leg: a request it does
   * not answer is a finding and throws naming the method and URL, never an
   * empty `200` a step would try to parse — after a `transcribe.otherwise` of
   * your own has declined it.
   */
  readonly pages?: FetchRouteTable | readonly FetchRouteHandler[] | FetchRouteHandler | undefined;
  /** Publish a recording synthesizer — `installStubSpeech`'s options, or `true` for the defaults. */
  readonly speech?: StubSpeechOptions | true | undefined;
  /**
   * Publish an in-memory upload store — `installStubUploads`'s two arguments
   * as one object: the `files` it holds by id, beside its options (`writable`,
   * `idPrefix`). `{}` publishes an empty read-only store; `{ writable: true }`
   * one a step may write into, read back on `files`.
   */
  readonly uploads?:
    | (StubUploadsOptions & { readonly files?: Readonly<Record<string, StubUpload>> | undefined })
    | undefined;
  /**
   * The `ASSEMBLYAI_API_KEY` to seed for this test, when the process holds
   * none. Defaults to a recognizable stub value; `false` seeds nothing.
   */
  readonly apiKey?: string | false | undefined;
  /**
   * Publish the recording reporter (`installStubReporter`). Defaults to
   * publishing one only when NO reporter is published yet — inside
   * `describeEval` the harness's reporter is what `run.reported` reads, and a
   * stub published over it emptied that log. `false` never publishes one;
   * `true` always does.
   */
  readonly reporter?: boolean | undefined;
};

/**
 * What {@link installStubWorld} returns: every fake's call log, live.
 *
 * @sealed
 * @public
 */
export type StubWorld = {
  /** Every completion request the gateway answered, decoded. */
  readonly model: StubGatewayCall[];
  /** Every transcription request, by leg — empty when `transcribe` was not named. */
  readonly provider: StubTranscribeCall[];
  /** Every line the synthesizer was asked to say — empty when `speech` was not named. */
  readonly speech: StubSpeechCall[];
  /**
   * The upload store itself — `undefined` when `uploads` was not named. Read a
   * file back with `read`; what a step wrote (under `writable`) is `writes`.
   */
  readonly files: StubUploads | undefined;
  /**
   * What the steps narrated and emitted (`installStubReporter`) — empty, and
   * recording nothing, when the world left a published reporter in place
   * (see `StubWorldOptions.reporter`).
   */
  readonly reported: StubReporter;
};

/**
 * Install every seam a workflow step reaches through, composed in the one
 * order that works, and seed the credential — restored when this test
 * finishes.
 *
 * A step's HTTP goes through ONE published `stepFetch`, so a flow that calls a
 * model AND fetches a page AND transcribes a recording cannot install three
 * fakes: whichever published last answers everything. The composition every
 * workflow spec therefore hand-wrote is the gateway route in FRONT of the page
 * stub (`model.route(request) ?? page()`), and in front of both the
 * transcription fake holding the slot with the pair as its `otherwise`. Get
 * the order wrong and the page stub answers the gateway's request with HTML,
 * which `stepGenerate` retries against until its budget runs out; a shipped
 * template carries a paragraph warning about exactly this. Here the order is
 * fixed, and a spec names only the legs it has.
 *
 * It also seeds `ASSEMBLYAI_API_KEY` (unless `apiKey: false`), because
 * `stepGenerate` refuses by name without one and the fake never reads it; the
 * previous value is put back when the test finishes. `stubGatewayRoute` itself
 * cannot seed anything — it installs nothing and owns no lifetime — so the
 * seeding lives with the installers.
 *
 * `installStubReporter` is installed too, so what the steps narrated is on
 * `reported` without a second call — unless a reporter is already published
 * (an eval's), which is left in place: `reporter` decides.
 *
 * @example
 * ```ts no-check
 * import { installStubWorld } from "@alexkroman1/aai/testing/vitest";
 *
 * test("the digest reads the page and asks the model", async () => {
 *   const world = installStubWorld({
 *     model: '{"headline":"Otters use tools","points":["They do."]}',
 *     pages: { "https://example.com/otters": { body: PAGE_HTML } },
 *   });
 *   await digest({ url: "https://example.com/otters" });
 *   expect(world.model[0]?.prompt).toContain("Otters");
 * });
 * ```
 *
 * @public
 */
export function installStubWorld(options: StubWorldOptions = {}): StubWorld {
  seedApiKey(options.apiKey);
  const model = options.model === undefined ? undefined : stubGatewayRoute(options.model);
  const pages = pagesHandler(options.pages);
  // The chain every leg falls through to, gateway FIRST: see the doc.
  const fallback = async (request: StubStepRequest): Promise<StubStepAnswer | undefined> =>
    model?.route(request) ?? (await pages?.(toRouteRequest(request)));
  // A finding, never an empty 200 — `stubFetchRoutes`' own default.
  const noLeg = (request: StubStepRequest): never => {
    throw new TypeError(`installStubWorld: no leg answers ${request.method} ${request.url}`);
  };
  let provider: StubTranscribe | undefined;
  if (options.transcribe !== undefined) {
    const own = options.transcribe.otherwise;
    provider = installStubTranscribe({
      ...options.transcribe,
      // A `pages` leg that declines is the finding it is on the other branch;
      // with no pages at all, the transcribe fake's own 404 stays the answer.
      otherwise: async (request) =>
        (await fallback(request)) ??
        (await own?.(request)) ??
        (pages === undefined ? undefined : noLeg(request)),
    });
  } else if (model !== undefined || pages !== undefined) {
    installStubStepFetch(async (request) => (await fallback(request)) ?? noLeg(request));
  }
  const speech =
    options.speech === undefined
      ? undefined
      : installStubSpeech(options.speech === true ? {} : options.speech);
  const { files: seeded = {}, ...uploadsOptions } = options.uploads ?? {};
  const files =
    options.uploads === undefined ? undefined : installStubUploads(seeded, uploadsOptions);
  return {
    model: model?.calls ?? [],
    provider: provider?.calls ?? [],
    speech: speech?.calls ?? [],
    files,
    reported:
      (options.reporter ?? !hasStepReporter())
        ? installStubReporter()
        : { lines: [], emitted: [], restore: () => undefined },
  };
}

/**
 * The `pages` leg as one handler: a table or list is routed by
 * `stubFetchRoutes`' own matcher (`routeOf`), installed nowhere and reached
 * only through the chain, declining what it does not answer so the chain's
 * own refusal names it.
 */
function pagesHandler(pages: StubWorldOptions["pages"]): FetchRouteHandler | undefined {
  if (pages === undefined || typeof pages === "function") return pages;
  return routeOf(pages);
}

/**
 * Declare a suite for one deployed agent: the built-in "is deployable" case,
 * then the body, handed the typed {@link ToolRunner} for the agent.
 *
 * Every shipped template's spec opened with the same two things — a
 * `describe(agentDef.name, …)` whose first case was `expectDeployable(agentDef)`,
 * and `const run = toolRunner(agentDef)` above it. The deployable case is the
 * one no agent spec should be without (a config the platform refuses is a spec
 * measuring nothing), and binding the runner is the line every file repeated.
 *
 * The body takes vitest's own `test`/`expect` from `vitest` as usual; only the
 * runner is handed in, so a case reads `run(addItem, { … })` typed, or
 * `run("add_item", …)` by name.
 *
 * @example
 * ```ts no-check
 * import agentDef from "virtual:aai/agent";
 * import { describeAgent } from "@alexkroman1/aai/testing/vitest";
 * import { expect, test } from "vitest";
 * import addItem from "./tools/add_item.ts";
 *
 * describeAgent(agentDef, (run) => {
 *   test("adds the item", async () => {
 *     const { added } = await run(addItem, { item: "apple" });
 *     expect(added).toBe("apple");
 *   });
 * });
 * ```
 *
 * @public
 */
export function describeAgent<
  const D extends ToolBearingAgent & {
    readonly name: string;
    readonly stt?: unknown;
    readonly llm?: unknown;
    readonly tts?: unknown;
  },
>(agent: D, define: (run: ToolRunner, agent: D) => void): void {
  describe(agent.name, () => {
    test("is deployable", () => {
      expectDeployable(agent);
    });
    define(runnerFor(agent), agent);
  });
}

/**
 * The agent's runner — or, for an agent that declares no tools, one that
 * answers `toolRunner`'s own refusal at the first `run(…)`. `toolRunner`
 * throws at BIND for that shape, and here the bind is the suite's, where a
 * throw would also take the deployable case with it; a tool-less agent still
 * has a config worth checking.
 */
function runnerFor(agent: ToolBearingAgent): ToolRunner {
  try {
    return toolRunner(agent);
  } catch (err) {
    return (() => Promise.reject(err)) as ToolRunner;
  }
}
