// Copyright 2026 the AAI authors. MIT license.
/**
 * Project-level tools for the studio coding agent — the voice-agent AAI
 * versions of the v0/Lovable project tools: dependency management
 * (`add_dependency`/`remove_dependency`), asset download
 * (`download_to_workspace`), and a design-brief generator
 * (`generate_design_inspiration`).
 *
 * Like every studio tool these execute INSIDE the guest sandbox: an npm
 * install or a slow download burns the tenant's own container, never the
 * platform host. The npm tools spawn `npm` with an args array (no shell)
 * and validate the package spec, so a spec can never smuggle flags or
 * shell syntax; the download tool routes its model-controlled URL through
 * the SDK's `safeFetch` SSRF screen, exactly as the web builtins do.
 *
 * Downloads are TEXT-ONLY by design: the workspace syncs to the host as
 * utf-8 strings, so a binary asset would corrupt in the round-trip. The
 * tool refuses non-utf-8 bodies with guidance (reference images by URL in
 * client.tsx) rather than writing a file that breaks at publish time.
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { safeFetch } from "@alexkroman1/aai/runtime";
import { generateText, type LanguageModel, type ToolSet, tool } from "ai";
import { z } from "zod";
import { MAX_STUDIO_FILE_BYTES } from "./limits.ts";
import { STUDIO_TOOL_DESCRIPTIONS } from "./studio-tool-descriptions.ts";
import { resolveInside } from "./studio-tools.ts";

/** Wall-clock limit for one npm install/uninstall. */
const NPM_TIMEOUT_MS = 110_000;
/** Output tail kept from npm (errors print last). */
const NPM_OUTPUT_CAP = 4000;
/** Deadline for one asset download. */
const DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * npm package spec: optional scope, name, optional version/tag/range after
 * `@`. Deliberately tight — a spec that can't match this can't smuggle a
 * leading `-` flag, a path, or a git URL into the npm invocation.
 */
const PACKAGE_SPEC_RE = /^(@[a-z0-9~][\w.~-]*\/)?[a-z0-9~][\w.~-]*(@[\w.^~<>=* -]+)?$/;

/**
 * The registry fields `npm_info` reports: enough to confirm a package and
 * its real import surface without guessing, small enough to stay readable.
 */
const NPM_INFO_FIELDS = [
  "name",
  "version",
  "description",
  "homepage",
  "exports",
  "peerDependencies",
];

function runNpm(dir: string, args: string[]): Promise<{ exitCode: number | null; output: string }> {
  const env = { ...process.env };
  delete env.AAI_GUEST_TOKEN;
  return new Promise((resolve, reject) => {
    const child = spawn("npm", [...args, "--no-audit", "--no-fund", "--loglevel=error"], {
      cwd: dir,
      env,
      timeout: NPM_TIMEOUT_MS,
    });
    let out = "";
    const keep = (chunk: Buffer) => {
      out = (out + chunk.toString()).slice(-NPM_OUTPUT_CAP);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({
        exitCode: code,
        output: signal ? `${out}\n[killed by ${signal} after ${NPM_TIMEOUT_MS}ms]` : out,
      });
    });
  });
}

async function npmTool(dir: string, verb: "install" | "uninstall", spec: string): Promise<string> {
  if (!PACKAGE_SPEC_RE.test(spec)) {
    return `Error: "${spec}" is not a valid npm package spec (expected name, @scope/name, or name@version)`;
  }
  try {
    const { exitCode, output } = await runNpm(dir, [verb, spec]);
    const body = output.trim();
    if (exitCode === 0) {
      return `npm ${verb} ${spec} succeeded${body ? `\n${body}` : ""}`;
    }
    return `npm ${verb} ${spec} failed [exit code ${exitCode}]\n${body || "(no output)"}`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function downloadToWorkspace(dir: string, url: string, rel: string): Promise<string> {
  let abs: string;
  try {
    abs = resolveInside(dir, rel);
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
  let response: Response;
  try {
    response = await safeFetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (err) {
    return `Error: fetch failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!response.ok) return `Error: ${url} answered ${response.status} ${response.statusText}`;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_STUDIO_FILE_BYTES) {
    return `Error: response is ${bytes.byteLength} bytes (max ${MAX_STUDIO_FILE_BYTES}) — too large to sync to the project`;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return (
      "Error: the response is binary, and the workspace only syncs text files — " +
      "reference binary assets (images, audio) by URL in client.tsx instead"
    );
  }
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, text, "utf-8");
  return `Downloaded ${url} to ${rel} (${bytes.byteLength} bytes)`;
}

export type ProjectToolDeps = {
  /** Absolute workspace root the session materialized. */
  dir: string;
  /** Types-only check of the workspace (`typecheckWorkspaceDir`). */
  typecheck: () => Promise<{ ok: true; skipped: boolean } | { ok: false; output: string }>;
};

/** Build the dependency + asset + typecheck tools over the session workspace. */
export function createProjectTools(deps: ProjectToolDeps): ToolSet {
  const { dir } = deps;
  return {
    check_types: tool({
      description: STUDIO_TOOL_DESCRIPTIONS.check_types,
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const result = await deps.typecheck();
          if (!result.ok) return result.output;
          return result.skipped
            ? "Typecheck skipped: the workspace has no tsconfig.json"
            : "No type errors";
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
    npm_info: tool({
      description: STUDIO_TOOL_DESCRIPTIONS.npm_info,
      inputSchema: z.object({
        package: z.string().describe('npm package to look up, e.g. "date-fns" or "zod@3"'),
      }),
      execute: async ({ package: spec }) => {
        if (!PACKAGE_SPEC_RE.test(spec)) {
          return `Error: "${spec}" is not a valid npm package spec (expected name, @scope/name, or name@version)`;
        }
        try {
          const { exitCode, output } = await runNpm(dir, ["view", spec, ...NPM_INFO_FIELDS]);
          const body = output.trim();
          if (exitCode !== 0) {
            return `npm view ${spec} failed [exit code ${exitCode}]\n${body || "(no output)"}`;
          }
          return body || `No registry metadata for ${spec}`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
    add_dependency: tool({
      description: STUDIO_TOOL_DESCRIPTIONS.add_dependency,
      inputSchema: z.object({
        package: z.string().describe('npm package to install, e.g. "date-fns" or "lodash@4"'),
      }),
      execute: ({ package: spec }) => npmTool(dir, "install", spec),
    }),
    remove_dependency: tool({
      description: STUDIO_TOOL_DESCRIPTIONS.remove_dependency,
      inputSchema: z.object({
        package: z.string().describe("npm package to uninstall"),
      }),
      execute: ({ package: spec }) => npmTool(dir, "uninstall", spec),
    }),
    download_to_workspace: tool({
      description: STUDIO_TOOL_DESCRIPTIONS.download_to_workspace,
      inputSchema: z.object({
        url: z.string().describe("The URL of the text file to download"),
        path: z.string().describe("Workspace-relative path to save it at, e.g. data/menu.json"),
      }),
      execute: ({ url, path: rel }) => downloadToWorkspace(dir, url, rel),
    }),
  };
}

const DESIGN_BRIEF_SYSTEM = `You write design briefs for a voice agent's custom
chat UI (a client.tsx built with React, Tailwind, and @alexkroman1/aai-ui).
Produce a concise, opinionated brief (under 300 words) with exactly these
sections:
- Direction: one sentence naming the aesthetic and the feeling it should evoke.
- Colors: exactly 3-5 total (1 primary, 2-3 neutrals, 0-2 accents), each with a
  hex value and where it is used. No gradients unless the goal demands one.
- Typography: at most 2 font families (headings + body), with weights.
- Layout: mobile-first structure for the chat shell, message list, and voice
  controls, in Tailwind terms (flex, gap, spacing scale).
- Details: 2-3 distinctive touches (border radii, motion, empty states) that
  keep it from looking like boilerplate.
Be specific enough to implement directly; never suggest emojis as icons or
decorative filler shapes.`;

/** The v0-style design-brief generator, on the session's own model. */
export function createDesignInspirationTool(model: LanguageModel): ToolSet {
  return {
    generate_design_inspiration: tool({
      description: STUDIO_TOOL_DESCRIPTIONS.generate_design_inspiration,
      inputSchema: z.object({
        goal: z.string().describe("High-level product / feature or UX goal"),
        context: z
          .string()
          .optional()
          .describe("Optional design cues, brand adjectives, constraints"),
      }),
      execute: async ({ goal, context }, opts) => {
        try {
          const { text } = await generateText({
            model,
            system: DESIGN_BRIEF_SYSTEM,
            prompt: `Goal: ${goal}${context ? `\nContext: ${context}` : ""}`,
            ...(opts?.abortSignal ? { abortSignal: opts.abortSignal } : {}),
          });
          return text;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
  };
}
