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
 * - `SandboxLoadJudge` (when Deno + the built guest harness are available):
 *   the built worker must load in a real studio sandbox and self-describe a
 *   valid agent config — i.e. the code actually works, not just parses.
 *
 * Requires a real LLM key (`ASSEMBLYAI_API_KEY` or `ANTHROPIC_API_KEY`, or
 * `STUDIO_LLM_PROVIDER`/`STUDIO_LLM_MODEL`); the whole suite skips without
 * one, so `pnpm test` stays hermetic. MCP is stubbed out — the eval measures
 * the model + system prompt + tools, not the docs server.
 *
 * Run: pnpm --filter aai-server test:evals
 * For the sandbox judge, build the guest harness first:
 *   pnpm --filter aai-server build   (or set GUEST_HARNESS_PATH)
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { UIMessage } from "ai";
import { expect } from "vitest";
import type { TranscriptEvent } from "vitest-evals";
import { createHarness, createJudge, describeEval } from "vitest-evals";
import { resolveHarnessPath } from "../constants.ts";
import { IsolateConfigSchema } from "../rpc-schemas.ts";
import { createTestStorage } from "../test-utils.ts";
import { runStudioChat, type StudioChatDeps } from "./studio-agent.ts";
import { getCachedBuild, putCachedBuild } from "./studio-build-cache.ts";
import { bundleWorkspaceWorker } from "./studio-bundle.ts";
import { StudioBuildError } from "./studio-errors.ts";
import { isStudioLlmConfigured, studioLlmInfo, studioModel } from "./studio-llm.ts";
import { createStudioSandbox, type StudioSandbox } from "./studio-sandbox.ts";
import { starterFiles } from "./studio-template.ts";
import { filesHash, getWorkspace, putWorkspace } from "./studio-workspace.ts";
import { withWorkspaceDir } from "./studio-workspace-dir.ts";

const SCOPE = "eval-scope";

const llmReady = isStudioLlmConfigured(process.env);

function isDenoAvailable(): boolean {
  try {
    execFileSync("deno", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** The sandbox judge needs Deno plus the built guest harness. */
const canSandbox = isDenoAvailable() && existsSync(resolveHarnessPath());

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
 * return the workspace it produced. Sandbox and MCP wiring mirror the chat
 * route, except MCP is stubbed and the sandbox degrades to "unavailable"
 * (which `test_agent` reports as tool-result text) when the environment
 * cannot spawn one — the one-shot output is judged either way.
 */
const studioHarness = createHarness<string, StudioEvalOutput>({
  name: "studio-coding-agent",
  run: async ({ input, setArtifact }) => {
    const project = `eval-${++runCounter}`;
    const storage = createTestStorage();
    await putWorkspace(storage, SCOPE, project, { files: starterFiles() });

    let sandbox: StudioSandbox | undefined;
    const deps: StudioChatDeps = {
      storage,
      scope: SCOPE,
      project,
      sandbox: async () => {
        if (!canSandbox) throw new Error("no Deno/guest harness in this environment");
        sandbox ??= await createStudioSandbox();
        return sandbox;
      },
      disposeSandbox: async () => {
        await sandbox?.dispose();
        sandbox = undefined;
      },
      model: studioModel(process.env),
      // No MCP: the eval measures the model + prompt + studio tools, and
      // must not depend on the docs server being reachable.
      mcp: { tools: {}, close: async () => undefined },
    };

    const events = await readSseEvents(await runStudioChat(deps, [userMessage(input)]));
    const workspace = await getWorkspace(storage, SCOPE, project);
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
 * Score 1 when the built worker loads in a real studio sandbox and reports a
 * valid agent config — the "actually works" gate. Optionally requires the
 * config to expose specific tool names.
 */
const SandboxLoadJudge = createJudge<string, StudioEvalOutput, { expectedTools?: string[] }>(
  "SandboxLoadJudge",
  async ({ output, expectedTools }) => {
    const worker = await buildWorker(output.files);
    const sandbox = await createStudioSandbox();
    try {
      const loaded = await sandbox.loadBundle(worker);
      const parsed = IsolateConfigSchema.safeParse(loaded.config);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => i.message).join("; ");
        return { score: 0, metadata: { rationale: `invalid agent config: ${issues}` } };
      }
      const tools = parsed.data.toolSchemas.map((schema) => schema.name);
      const missing = (expectedTools ?? []).filter((name) => !tools.includes(name));
      if (missing.length > 0) {
        return {
          score: 0,
          metadata: { rationale: `missing expected tools: ${missing.join(", ")}`, tools },
        };
      }
      return {
        score: 1,
        metadata: { rationale: `loaded agent "${parsed.data.name}"`, tools },
      };
    } catch (err) {
      return { score: 0, metadata: { rationale: `bundle failed to load: ${String(err)}` } };
    } finally {
      await sandbox.dispose();
    }
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
          "reports each flip as heads or tails. Keep the existing roll_dice " +
          "tool. Do everything in one go without asking questions.",
      );
      expect(Object.keys(result.output.files)).toContain("agent.ts");
      if (canSandbox) {
        await expect(result).toSatisfyJudge(SandboxLoadJudge, {
          expectedTools: ["flip_coin", "roll_dice"],
          threshold: 1,
        });
      }
    });

    it("rewrites the project from scratch", async ({ run }) => {
      const result = await run(
        'Replace this project with a voice agent called "Tip Helper". It ' +
          "needs a calculate_tip tool that takes bill_amount and tip_percent " +
          "and returns the tip and the total. Do everything in one go " +
          "without asking questions.",
      );
      expect(result.output.files["agent.ts"]).toMatch(/Tip Helper/);
      if (canSandbox) {
        await expect(result).toSatisfyJudge(SandboxLoadJudge, {
          expectedTools: ["calculate_tip"],
          threshold: 1,
        });
      }
    });
  },
);
