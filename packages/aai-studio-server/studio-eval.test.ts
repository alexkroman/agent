// Copyright 2025 the AAI authors. MIT license.
/**
 * One-shot codegen evals for the studio coding agent (vitest-evals).
 *
 * Each case gives the real agent loop (`runStudioChat` with the host-env
 * selected LLM) a single user prompt against a fresh starter workspace, then
 * judges the workspace it leaves behind:
 *
 * - `WorkerBuildJudge` (always): the workspace must survive the exact
 *   Vite/Rollup pass Publish runs (`bundleWorkspaceWorker`) — i.e. the agent
 *   one-shot produced syntactically valid code with legal imports.
 * - `SandboxLoadJudge` (when Modal credentials + the built guest harness are
 *   available): the built worker must load in a real studio sandbox and
 *   self-describe a valid agent config — i.e. the code actually works, not
 *   just parses. It also asserts any config facts the case declares (expected
 *   tools, provider kinds).
 * - `TemplateParityJudge`: the workspace must be functionally equivalent to a
 *   hand-written template in `packages/aai-templates/templates/` — i.e. the
 *   agent built the *right* thing, not merely a thing that loads.
 *
 * Two families of case, in `_studio-eval-test-utils.ts`:
 *
 * - `TEMPLATE_CASES` — the prompt is one of the studio's own starter prompts
 *   (`aai-studio-client/src/starters.ts`, each modeled on a template) and the
 *   matching template is the reference the result is graded against. The
 *   prompts are duplicated rather than imported: `aai-server` and
 *   `aai-studio-client` talk over HTTP only, with no code imports either way.
 * - `CONFIG_CASES` — no reference and no parity judge, just facts the built
 *   worker must report: AssemblyAI backs every stage the prompt didn't assign
 *   elsewhere. A "does this run once published" rule that a resemblance
 *   grader is the wrong instrument for — several references legitimately use
 *   other providers, so parity and runnability disagree.
 *
 * Requires a real LLM key (`ASSEMBLYAI_API_KEY` or `ANTHROPIC_API_KEY`, or
 * `STUDIO_LLM_PROVIDER`/`STUDIO_LLM_MODEL`); the whole suite skips without
 * one, so `pnpm test` stays hermetic.
 *
 * Run: pnpm --filter aai-server test:evals
 * For the sandbox judge, build the guest harness first:
 *   pnpm --filter aai-server build   (or set GUEST_HARNESS_PATH)
 * Build `@alexkroman1/aai` too (`pnpm --filter @alexkroman1/aai build`): the
 * worker build resolves a workspace's SDK imports through the package's
 * `import` condition, i.e. `dist/`, never `@dev/source`. A stale dist makes a
 * newly added subpath (`@alexkroman1/aai/patterns`) unresolvable and every
 * case that imports it fails `WorkerBuildJudge` — with a rolldown "not
 * exported under the conditions" error that reads like generated-code trouble.
 */

import { existsSync, readdirSync } from "node:fs";
import { resolveHarnessPath } from "aai-server/constants";
import { isModalConfigured } from "aai-server/modal-sandbox";
import { type IsolateConfig, IsolateConfigSchema } from "aai-server/rpc-schemas";
import { createMemoryWorkspaceStore } from "aai-server/workspace-store";
import { generateObject, type UIMessage } from "ai";
import { describe, expect, test } from "vitest";
import type { TranscriptEvent } from "vitest-evals";
import { createHarness, createJudge, describeEval } from "vitest-evals";
import { z } from "zod";
import {
  CONFIG_CASES,
  ONE_SHOT,
  type ProviderExpectation,
  readTemplate,
  renderFiles,
  TEMPLATE_CASES,
  TEMPLATES_DIR,
  UNCOVERED,
} from "./_studio-eval-test-utils.ts";
import { runStudioChat, type StudioChatDeps } from "./studio-agent.ts";
import { getCachedBuild, putCachedBuild } from "./studio-build-cache.ts";
import { bundleWorkspaceWorker } from "./studio-bundle.ts";
import { StudioBuildError } from "./studio-errors.ts";
import { studioLlmInfo, studioModel } from "./studio-llm.ts";
import { createStudioSandbox, type StudioSandbox } from "./studio-sandbox.ts";
import { starterFiles } from "./studio-template.ts";
import { createWorkspace, filesHash, getWorkspace } from "./studio-workspace.ts";
import { withWorkspaceDir } from "./studio-workspace-dir.ts";

const SCOPE = "eval-scope";

// The studio LLM now runs on the caller's key; evals borrow the shell's.
const evalApiKey = process.env.ASSEMBLYAI_API_KEY ?? "";
const llmReady = Boolean(evalApiKey);

/** The sandbox judge needs Modal credentials plus the built guest harness. */
const canSandbox = isModalConfigured() && existsSync(resolveHarnessPath());

type StudioEvalOutput = {
  /** Workspace files as the agent left them after its one turn. */
  files: Record<string, string>;
  /** Concatenated assistant text from the turn. */
  assistantText: string;
};

/** Build the workspace's worker, sharing the studio's content-hash cache. */
async function buildWorker(files: Record<string, string>): Promise<string> {
  const hash = filesHash(files);
  const cached = getCachedBuild(hash)?.worker;
  if (cached !== undefined) return cached;
  const worker = await withWorkspaceDir(files, bundleWorkspaceWorker);
  putCachedBuild(hash, { worker });
  return worker;
}

function userMessage(text: string): UIMessage {
  return { id: "m1", role: "user", parts: [{ type: "text", text }] };
}

/** Parse the SSE UI message stream into its JSON events (consumes the body). */
async function readSseEvents(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(6)));
}

/** Map UI stream events to a normalized transcript for eval reporters. */
function toTranscript(input: string, events: Record<string, unknown>[]): TranscriptEvent[] {
  const out: TranscriptEvent[] = [{ type: "message", role: "user", content: input }];
  const toolNames = new Map<string, string>();
  let assistantText = "";
  for (const event of events) {
    if (event.type === "text-delta" && typeof event.delta === "string") {
      assistantText += event.delta;
    } else if (event.type === "tool-input-available") {
      const id = String(event.toolCallId);
      const name = String(event.toolName);
      toolNames.set(id, name);
      out.push({ type: "tool_call", id, name, arguments: event.input as never });
    } else if (event.type === "tool-output-available") {
      const id = String(event.toolCallId);
      out.push({
        type: "tool_result",
        toolCallId: id,
        name: toolNames.get(id) ?? "unknown",
        content: event.output as never,
      });
    }
  }
  out.push({ type: "message", role: "assistant", content: assistantText });
  return out;
}

let runCounter = 0;

/**
 * Run one real coding-agent turn against a fresh starter workspace and
 * return the workspace it produced. Sandbox wiring mirrors the chat route,
 * except the sandbox degrades to "unavailable" (which `test_agent` reports
 * as tool-result text) when the environment cannot spawn one — the one-shot
 * output is judged either way.
 */
const studioHarness = createHarness<string, StudioEvalOutput>({
  name: "studio-coding-agent",
  run: async ({ input, setArtifact }) => {
    const project = `eval-${++runCounter}`;
    const workspaces = createMemoryWorkspaceStore();
    await createWorkspace(workspaces, SCOPE, project, { files: starterFiles() });

    let sandbox: StudioSandbox | undefined;
    const deps: StudioChatDeps = {
      workspaces,
      scope: SCOPE,
      project,
      sandbox: async () => {
        if (!canSandbox) throw new Error("no Modal credentials/guest harness in this environment");
        sandbox ??= await createStudioSandbox();
        return sandbox;
      },
      disposeSandbox: async () => {
        await sandbox?.dispose();
        sandbox = undefined;
      },
      model: studioModel(evalApiKey),
    };

    const events = await readSseEvents(await runStudioChat(deps, [userMessage(input)]));
    const workspace = await getWorkspace(workspaces, SCOPE, project);
    const errors = events.filter((e) => e.type === "error").map((e) => String(e.errorText));
    // Fail loudly on an errored turn. Judging the leftover workspace would be
    // a false pass — the untouched starter files build just fine.
    if (errors.length > 0) {
      throw new Error(`agent turn errored: ${errors.join("; ")}`);
    }
    const transcript = toTranscript(input, events);
    const assistant = transcript.at(-1);
    setArtifact("llm", (studioLlmInfo(process.env) ?? {}) as never);
    setArtifact("steps", events.filter((e) => e.type === "start-step").length);
    return {
      output: {
        files: workspace?.files ?? {},
        assistantText:
          assistant?.type === "message" && typeof assistant.content === "string"
            ? assistant.content
            : "",
      },
      events: transcript,
      errors,
    };
  },
});

/**
 * Score 1 when the workspace builds through the production worker bundler —
 * the "syntactically valid" gate. Build diagnostics become the rationale.
 */
const WorkerBuildJudge = createJudge<string, StudioEvalOutput>(
  "WorkerBuildJudge",
  async ({ output }) => {
    try {
      await buildWorker(output.files);
      return { score: 1, metadata: { rationale: "workspace builds" } };
    } catch (err) {
      if (err instanceof StudioBuildError) {
        return { score: 0, metadata: { rationale: err.message } };
      }
      throw err;
    }
  },
);

/**
 * Provider mismatches between the config the guest reported and what the case
 * expects. Empty means it matches.
 *
 * Kinds rather than descriptor identity — the case cares that the AssemblyAI
 * gateway is doing the LLM work — with one exception: when the case sets
 * `llmModel`, the exact gateway model id is asserted too, because the studio
 * preamble names a default model and a case where the prompt names none is
 * the only place that default is observable.
 */
function providerProblems(cfg: IsolateConfig, want: ProviderExpectation): string[] {
  const got = { stt: cfg.stt?.kind, llm: cfg.llm?.kind, tts: cfg.tts?.kind };
  const stages = ["stt", "llm", "tts"] as const;
  if (want.mode === "s2s") {
    const declared = stages.filter((stage) => got[stage] !== undefined);
    if (declared.length === 0) return [];
    const shown = declared.map((stage) => `${stage}=${got[stage]}`).join(", ");
    return [
      "expected the AssemblyAI voice agent API (S2S: none of stt/llm/tts declared) " +
        `but the agent runs a pipeline: ${shown}`,
    ];
  }
  const problems = stages
    .filter((stage) => got[stage] !== want[stage])
    .map((stage) => `${stage} provider is "${got[stage] ?? "unset"}", expected "${want[stage]}"`);
  if (want.llmModel !== undefined) {
    const model = cfg.llm?.options.model;
    if (model !== want.llmModel) {
      problems.push(
        `llm model is ${model === undefined ? "unset" : `"${String(model)}"`}, ` +
          `expected the default "${want.llmModel}"`,
      );
    }
  }
  return problems;
}

/**
 * Score 1 when the built worker loads in a real studio sandbox and reports a
 * valid agent config — the "actually works" gate. Optionally asserts config
 * facts on top: specific tool names and which providers back each stage.
 *
 * These are checked here rather than by a rubric because they are facts about
 * the config, and a judge reading source can be argued out of a fact.
 */
const SandboxLoadJudge = createJudge<
  string,
  StudioEvalOutput,
  { expectedTools?: string[]; providers?: ProviderExpectation }
>("SandboxLoadJudge", async ({ output, expectedTools, providers }) => {
  const worker = await buildWorker(output.files);
  const sandbox = await createStudioSandbox();
  try {
    const loaded = await sandbox.loadBundle(worker);
    const parsed = IsolateConfigSchema.safeParse(loaded.config);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => i.message).join("; ");
      return { score: 0, metadata: { rationale: `invalid agent config: ${issues}` } };
    }
    const config = parsed.data;
    const tools = config.toolSchemas.map((schema) => schema.name);
    const problems: string[] = [];

    const missing = (expectedTools ?? []).filter((name) => !tools.includes(name));
    if (missing.length > 0) problems.push(`missing expected tools: ${missing.join(", ")}`);

    if (providers !== undefined) problems.push(...providerProblems(config, providers));

    if (problems.length > 0) {
      return { score: 0, metadata: { rationale: problems.join(" | "), tools } };
    }
    return {
      score: 1,
      metadata: { rationale: `loaded agent "${config.name}"`, tools },
    };
  } catch (err) {
    return { score: 0, metadata: { rationale: `bundle failed to load: ${String(err)}` } };
  } finally {
    await sandbox.dispose();
  }
});

/**
 * The parity rubric. Ids are stable so a failure means the same thing across
 * runs and models; each entry is the question the judge answers about one
 * dimension of "is this the same agent as the reference".
 */
const RUBRIC_IDS = ["mode", "capabilities", "state", "assets", "persona"] as const;

const RUBRIC: Record<(typeof RUBRIC_IDS)[number], string> = {
  mode:
    "Unless the user prompt asked for the AssemblyAI voice agent API (S2S / " +
    "speech-to-speech), the generated agent runs in pipeline mode with all three " +
    "of stt/llm/tts declared — the studio's default is a cascaded all-AssemblyAI " +
    "pipeline, so a pipeline agent is correct even where the reference declares " +
    "no providers (S2S). If the prompt DID ask for the voice agent API, none of " +
    "stt/llm/tts may be declared. " +
    "Additionally, if the user prompt named specific providers, models, or voices, " +
    "those are the ones used. Every stage the prompt left open must be " +
    "AssemblyAI, even where the reference uses a different provider: " +
    "ASSEMBLYAI_API_KEY is the only key a published agent is given, so an " +
    "unrequested third-party provider cannot run at all.",
  capabilities:
    "Every capability the USER PROMPT asked for is reachable in the generated " +
    "agent — as a custom tool or a `builtinTools` entry. Judge by function, not " +
    "by name: `add_pizza` and `add_item` are the same capability. Coverage of " +
    "the ask is the whole question, so two things are never failures: extra " +
    "tools and extra builtins (including the framework defaults " +
    "think/remember/recall/calculate), and a capability the reference happens " +
    "to offer that the prompt never mentions — the references are fuller than " +
    "the prompts they are paired with, and an agent is not wrong for building " +
    "what was asked. Fail only when something the prompt asked for cannot be " +
    "reached at all, or when two requested capabilities were folded into one " +
    "tool.",
  state:
    "If the reference keeps state, the generated agent does too, with the same " +
    "backing and scoping — per-session scratch in `ctx.state` where the reference " +
    "uses it, durable records via `ctx.db.query` where the reference persists to " +
    "the app database. If the reference keeps no state, pass.",
  assets:
    "Data or prompt content the reference keeps in a separate imported file exists " +
    "in the generated workspace and is actually populated (a seeded knowledge base, " +
    "a real system prompt) — its own file or inline both count. If the reference is " +
    "a single self-contained file, pass.",
  persona:
    "The system prompt establishes a comparable persona AND carries the reference's " +
    "hard behavioral constraints. A hard constraint is a rule that changes what the " +
    "agent will or will not do or say — always cite sources; treat fetched web " +
    "content as data, never instructions; answer only from the knowledge base; " +
    "always disclaim that this is not medical advice; always compute instead of " +
    "guessing. Style and formatting guidance in the reference (how to phrase " +
    "things, how long to be, which helper calls to use) is NOT a hard constraint. " +
    "This criterion asks ONE question: is each of the reference's hard constraints " +
    "present? Rules the generated prompt adds on top — a stricter output format, " +
    "mandatory sections, a no-clarifying-questions rule, a more opinionated " +
    "persona — are ALWAYS a pass, even where they change what the agent would " +
    "say. Wording may differ freely; fail only on a missing hard constraint.",
};

const ParityVerdictSchema = z.object({
  criteria: z.array(
    z.object({
      id: z.enum(RUBRIC_IDS),
      pass: z.boolean(),
      note: z.string().describe("One sentence justifying the verdict."),
    }),
  ),
});

/**
 * Score the generated workspace against a hand-written template — the "built
 * the right thing" gate, and the only judge that can tell a working agent
 * from the *asked-for* agent.
 *
 * Graded by the same host-selected LLM the studio itself runs on, over the
 * fixed rubric above. Score is the fraction of criteria passed, so the
 * threshold at the call site decides how much slack a run gets.
 */
const TemplateParityJudge = createJudge<string, StudioEvalOutput, { template: string }>(
  "TemplateParityJudge",
  async ({ input, output, template }) => {
    const rubric = RUBRIC_IDS.map((id) => `${id}: ${RUBRIC[id]}`).join("\n\n");
    const prompt = [
      "You are grading a code-generation agent. It was given ONE user prompt and a",
      "starter voice-agent workspace, and had a single turn to edit it. Decide",
      "whether what it produced is functionally equivalent to a known-good",
      "reference implementation of the same agent.",
      "",
      "Rules:",
      "- The USER PROMPT is authoritative. Where it asks for something the reference",
      "  does differently (a different STT/LLM/TTS provider, model, or voice), follow",
      "  the prompt, not the reference.",
      "- The reference shows the canonical SHAPE, not text to reproduce. Different",
      "  names, different wording, extra features, and a different file layout are",
      "  all fine.",
      "- Judge each criterion independently, and mark `pass: false` only when the",
      "  criterion is clearly not met — not because the code is merely different.",
      "- Never fail a criterion because the generated agent does MORE than the",
      "  reference, or is stricter, more opinionated, or more specific than it.",
      "  This grades whether the reference's substance is present, not whether the",
      "  two would behave identically — a richer agent is a pass, not a mismatch.",
      "",
      `## Criteria (return exactly one entry per id)\n${rubric}`,
      "",
      // The one-shot suffix is an instruction to the *coding* agent, not a spec
      // for the voice agent it writes. Left in, the judge grades the generated
      // system prompt against it and fails a persona for "asking questions".
      `## User prompt\n${input.replace(ONE_SHOT, "")}`,
      "",
      `## Reference implementation (templates/${template})\n${renderFiles(readTemplate(template))}`,
      "",
      `## Generated workspace\n${renderFiles(output.files)}`,
    ].join("\n");

    const { object } = await generateObject({
      model: studioModel(evalApiKey),
      schema: ParityVerdictSchema,
      // Deliberately no `temperature: 0`: the default studio model is a
      // reasoning model, which rejects the parameter with an AI SDK warning on
      // every call. Run-to-run variance here is dominated by the *generation*
      // side anyway — the same prompt produces a different workspace each run.
      prompt,
    });

    const verdicts = new Map(object.criteria.map((c) => [c.id, c]));
    const failures = RUBRIC_IDS.filter((id) => verdicts.get(id)?.pass !== true).map((id) => {
      // A criterion the judge skipped counts as a failure — silently scoring it
      // as a pass would inflate every partial answer into a clean run.
      const note = verdicts.get(id)?.note ?? "judge returned no verdict for this criterion";
      return `${id}: ${note}`;
    });

    return {
      score: (RUBRIC_IDS.length - failures.length) / RUBRIC_IDS.length,
      metadata: {
        rationale:
          failures.length === 0
            ? `matches templates/${template} on all ${RUBRIC_IDS.length} criteria`
            : failures.join(" | "),
        template,
      },
    };
  },
);

describeEval(
  "studio coding agent — one-shot codegen",
  {
    harness: studioHarness,
    // Every run must produce a workspace that builds; a 0 fails the test.
    judges: [WorkerBuildJudge],
    judgeThreshold: 1,
    skipIf: () => !llmReady,
  },
  (it) => {
    it("adds a tool to the starter agent", async ({ run }) => {
      const result = await run(
        "Add a flip_coin tool to the agent. It takes a `count` (1-10) and " +
          "reports each flip as heads or tails. Keep the existing roll_dice tool." +
          ONE_SHOT,
      );
      expect(Object.keys(result.output.files)).toContain("agent.ts");
      if (canSandbox) {
        await expect(result).toSatisfyJudge(SandboxLoadJudge, {
          expectedTools: ["flip_coin", "roll_dice"],
          threshold: 1,
        });
      }
    });

    // The template cases are all from-scratch rewrites of the starter
    // workspace, graded against the hand-written template of the same shape.
    for (const { template, prompt } of TEMPLATE_CASES) {
      it(`builds the ${template} shape`, async ({ run }) => {
        const result = await run(prompt);
        expect(Object.keys(result.output.files)).toContain("agent.ts");
        if (canSandbox) {
          // No `expectedTools` here: generated tool names legitimately differ
          // from the template's, and capability coverage is the parity judge's
          // job. This is the "loads and self-describes" gate.
          await expect(result).toSatisfyJudge(SandboxLoadJudge, { threshold: 1 });
        }
        // 0.8 of a 5-criterion rubric: at most one criterion may miss. Runs
        // mostly score 1.00; the slack absorbs residual tension between a
        // reference constraint and this eval's one-shot framing (the
        // embedded-assets prompt tells the agent to ask when a question is
        // ambiguous, which `ONE_SHOT` pushes against).
        await expect(result).toSatisfyJudge(TemplateParityJudge, { template, threshold: 0.8 });
      });
    }

    // Config cases assert what the built worker reports about itself — which
    // providers back each stage. These are "will this run once published"
    // questions, which is why they are facts checked against the config
    // rather than rubric criteria.
    for (const { name, prompt, providers } of CONFIG_CASES) {
      it(name, async ({ run }) => {
        const result = await run(prompt);
        expect(Object.keys(result.output.files)).toContain("agent.ts");
        // Without a sandbox this case still gates on WorkerBuildJudge, but the
        // config facts — the whole point of the case — go unchecked.
        if (canSandbox) {
          await expect(result).toSatisfyJudge(SandboxLoadJudge, {
            providers,
            threshold: 1,
          });
        }
      });
    }
  },
);

/**
 * Cheap, LLM-free guard: every template is either evaluated or explicitly
 * excused. Adding a template forces a decision here.
 *
 * Only runs in the evals tier (this file is excluded from the unit project),
 * which is also when it matters — you run the evals when you touch the studio
 * prompt or the templates.
 */
describe("template eval coverage", () => {
  test("every template is covered or explicitly excused", () => {
    const byName = (a: string, b: string) => a.localeCompare(b);
    const templates = readdirSync(TEMPLATES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(byName);
    expect(templates.length).toBeGreaterThan(0);

    const covered = new Set(TEMPLATE_CASES.map((c) => c.template));
    const unevaluated = templates.filter((name) => !(covered.has(name) || name in UNCOVERED));
    expect(
      unevaluated,
      "add a TEMPLATE_CASES entry or an UNCOVERED reason for these templates",
    ).toEqual([]);

    // The other direction: a renamed or deleted template must not leave a
    // dangling case or excuse behind.
    const known = new Set(templates);
    const stale = [...covered, ...Object.keys(UNCOVERED)]
      .filter((name) => !known.has(name))
      .sort(byName);
    expect(stale, "these templates no longer exist").toEqual([]);
  });
});
