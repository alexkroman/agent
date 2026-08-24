// Copyright 2026 the AAI authors. MIT license.
/**
 * Project-level tools for the studio coding agent — the voice-agent AAI
 * versions of the v0/Lovable project tools: dependency management
 * (`add_dependency`/`remove_dependency`/`update_dependencies`), asset
 * download (`download_to_workspace`), and a design-brief generator
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

import { errorMessage, type ToolDef, tool } from "@alexkroman1/aai";
import { isRecord } from "@alexkroman1/aai/utils";
import { safeFetch } from "@alexkroman1/aai-runtime/internal";
import { z } from "zod";
import { MAX_STUDIO_FILE_BYTES } from "./limits.ts";
import { WORKSPACE_DEPENDENCIES } from "./studio-project-shape.ts";
import { NPM_TIMEOUT_MS, outputWithKillNote, PACKAGE_NAME_RE, runNpm } from "./studio-spawn.ts";
import { STUDIO_TOOL_DESCRIPTIONS } from "./studio-tool-descriptions.ts";
import {
  readWorkspaceManifest,
  resolveInside,
  writeFileWithParents,
} from "./studio-workspace-fs.ts";

/** Deadline for one asset download. */
const DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * npm package spec: optional scope, name, optional version/tag/range after
 * `@`. Deliberately tight — a spec that can't match this can't smuggle a
 * leading `-` flag, a path, or a git URL into the npm invocation.
 */
const PACKAGE_SPEC_RE = /^(@[a-z0-9~][\w.~-]*\/)?[a-z0-9~][\w.~-]*(@[\w.^~<>=* -]+)?$/;

/**
 * Packages whose versions the PLATFORM owns, never the registry.
 *
 * A workspace manifest does not declare them — they resolve from the baked
 * toolchain above it (see `WORKSPACE_DEPENDENCIES`) — so ordinarily none of
 * them reaches this tool at all. The guard is for the workspace that names one
 * by hand: bumping it would install a newer SDK, React or Tailwind into the
 * workspace's own `node_modules`, which SHADOWS the baked copy the harness
 * resolved and the build was tested against.
 */
const TOOLCHAIN_MANAGED: ReadonlySet<string> = new Set(WORKSPACE_DEPENDENCIES);

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

/**
 * {@link runNpm} with this file's output contract: a kill is folded INTO the
 * output string, because these tools return one string to the model and a
 * separate signal field would have nowhere to go.
 */
async function npmOutput(
  dir: string,
  args: string[],
): Promise<{ exitCode: number | null; output: string }> {
  const result = await runNpm(dir, args);
  return { exitCode: result.exitCode, output: outputWithKillNote(result, NPM_TIMEOUT_MS) };
}

/**
 * The refusal for a spec that cannot go on an npm command line. One spelling,
 * because it is one rule (PACKAGE_SPEC_RE) and both surfaces that check it —
 * `npm_info` and the install/uninstall pair — had their own copy of the prose.
 */
function invalidSpec(spec: string): string {
  return `Error: "${spec}" is not a valid npm package spec (expected name, @scope/name, or name@version)`;
}

/**
 * The non-zero-exit answer both npm tools give. One spelling, so the
 * `(no output)` placeholder and the `[exit code N]` shape cannot drift
 * between `npm_info` and the install/uninstall pair.
 */
function npmFailure(label: string, exitCode: number | null, body: string): string {
  return `${label} failed [exit code ${exitCode}]\n${body || "(no output)"}`;
}

async function npmTool(dir: string, verb: "install" | "uninstall", spec: string): Promise<string> {
  if (!PACKAGE_SPEC_RE.test(spec)) return invalidSpec(spec);
  try {
    const { exitCode, output } = await npmOutput(dir, [verb, spec]);
    const body = output.trim();
    if (exitCode === 0) {
      return `npm ${verb} ${spec} succeeded${body ? `\n${body}` : ""}`;
    }
    return npmFailure(`npm ${verb} ${spec}`, exitCode, body);
  } catch (err) {
    return `Error: ${errorMessage(err)}`;
  }
}

/**
 * The workspace's declared dependency specs, both kinds merged.
 *
 * `npm install <name>@latest` updates an entry wherever it already lives, so
 * the two sets are one namespace as far as this tool is concerned;
 * `dependencies` wins a (malformed) duplicate, matching npm's own precedence.
 */
function declaredSpecs(manifest: unknown): Record<string, string> {
  const m = isRecord(manifest) ? manifest : {};
  const pick = (key: string): Record<string, string> => {
    const value = m[key];
    return isRecord(value) ? (value as Record<string, string>) : {};
  };
  return { ...pick("devDependencies"), ...pick("dependencies") };
}

/** One `name: before → after` line per package the install was asked about. */
function describeUpdates(
  targets: string[],
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  return targets.map((name) => {
    const from = before[name];
    const to = after[name];
    if (to === undefined) return `${name}: no longer declared in package.json`;
    if (to === from) return `${name}: ${to} (unchanged — already latest)`;
    return `${name}: ${from} → ${to}`;
  });
}

/**
 * Split the packages under consideration into the ones to install, the
 * toolchain-owned ones to leave alone, and the ones the manifest never
 * declared. An empty request means "every declared package".
 */
function partitionTargets(
  requested: string[],
  declared: string[],
): { targets: string[]; pinned: string[]; undeclared: string[] } {
  const targets: string[] = [];
  const pinned: string[] = [];
  const undeclared: string[] = [];
  const isDeclared = new Set(declared);
  for (const name of requested.length > 0 ? requested : declared) {
    if (TOOLCHAIN_MANAGED.has(name)) pinned.push(name);
    else if (!isDeclared.has(name)) undeclared.push(name);
    else targets.push(name);
  }
  return { targets, pinned, undeclared };
}

/** Trailing lines explaining every name the install deliberately skipped. */
function skipNotes(pinned: string[], undeclared: string[]): string[] {
  const notes: string[] = [];
  if (undeclared.length > 0) {
    notes.push(
      `Not declared in package.json — use add_dependency to install: ${undeclared.join(", ")}`,
    );
  }
  if (pinned.length > 0) {
    notes.push(
      "Left pinned (the platform owns these versions and builds resolve them " +
        `from the installed toolchain): ${pinned.join(", ")}`,
    );
  }
  return notes;
}

/**
 * Bump declared dependencies to the registry's latest.
 *
 * With no names, every updatable declared package is bumped in ONE npm
 * invocation — npm resolves the set together, so a peer conflict between two
 * of them fails the whole install rather than leaving the manifest half
 * updated. The report is a diff of the DECLARED specs (read before, read
 * after), because npm's own output says how many packages changed on disk,
 * not which versions the manifest now asks for — and the manifest is what the
 * build bundles.
 */
async function updateDependencies(dir: string, requested?: string[]): Promise<string> {
  const names = [...new Set(requested ?? [])];
  const invalid = names.filter((name) => !PACKAGE_NAME_RE.test(name));
  if (invalid.length > 0) {
    return (
      `Error: ${invalid.join(", ")} — not valid npm package name(s). ` +
      "Pass names only; the target version is always the registry's latest."
    );
  }
  const manifest = await readWorkspaceManifest(dir);
  if (manifest === null) {
    return "Error: package.json is missing or is not valid JSON — fix it before updating dependencies";
  }
  const before = declaredSpecs(manifest);
  const { targets, pinned, undeclared } = partitionTargets(names, Object.keys(before));
  const notes = skipNotes(pinned, undeclared);
  if (targets.length === 0) {
    return ["No dependencies to update.", ...notes].join("\n");
  }

  try {
    const { exitCode, output } = await npmOutput(dir, [
      "install",
      ...targets.map((name) => `${name}@latest`),
    ]);
    const body = output.trim();
    const after = declaredSpecs(await readWorkspaceManifest(dir));
    // A failure is diffed too, and only the diff decides whether to claim
    // nothing changed: npm aborts a resolution conflict before touching the
    // manifest, but a lifecycle-script failure lands after the write, and
    // "nothing was updated" would then be a lie the agent acts on.
    const changed = targets.filter((name) => after[name] !== before[name]);
    if (exitCode !== 0) {
      return [
        changed.length === 0
          ? `npm install failed [exit code ${exitCode}] — nothing was updated`
          : `npm install failed [exit code ${exitCode}], but package.json changed:`,
        ...describeUpdates(changed, before, after),
        body || "(no output)",
        ...notes,
      ].join("\n");
    }
    return [
      "Updated to the registry's latest:",
      ...describeUpdates(targets, before, after),
      ...notes,
    ].join("\n");
  } catch (err) {
    return `Error: ${errorMessage(err)}`;
  }
}

async function downloadToWorkspace(dir: string, url: string, rel: string): Promise<string> {
  let abs: string;
  try {
    abs = resolveInside(dir, rel);
  } catch (err) {
    return `Error: ${errorMessage(err)}`;
  }
  let response: Response;
  try {
    response = await safeFetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (err) {
    return `Error: fetch failed: ${errorMessage(err)}`;
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
  await writeFileWithParents(abs, text);
  return `Downloaded ${url} to ${rel} (${bytes.byteLength} bytes)`;
}

export type ProjectToolDeps = {
  /** Absolute workspace root the session materialized. */
  dir: string;
};

/** Build the dependency + asset tools over the session workspace. */
export function createProjectTools(deps: ProjectToolDeps): Record<string, ToolDef> {
  const { dir } = deps;
  return {
    npm_info: tool({
      description: STUDIO_TOOL_DESCRIPTIONS.npm_info,
      inputSchema: z.object({
        package: z.string().describe('npm package to look up, e.g. "date-fns" or "zod@3"'),
      }),
      execute: async ({ package: spec }) => {
        if (!PACKAGE_SPEC_RE.test(spec)) return invalidSpec(spec);
        try {
          const { exitCode, output } = await npmOutput(dir, ["view", spec, ...NPM_INFO_FIELDS]);
          const body = output.trim();
          if (exitCode !== 0) {
            return npmFailure(`npm view ${spec}`, exitCode, body);
          }
          return body || `No registry metadata for ${spec}`;
        } catch (err) {
          return `Error: ${errorMessage(err)}`;
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
    update_dependencies: tool({
      description: STUDIO_TOOL_DESCRIPTIONS.update_dependencies,
      inputSchema: z.object({
        packages: z
          .array(z.string())
          .optional()
          .describe(
            'Package NAMES to update (no versions), e.g. ["date-fns"]. ' +
              "Omit to update every updatable package declared in package.json.",
          ),
      }),
      execute: ({ packages }) => updateDependencies(dir, packages),
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

/**
 * The v0-style design-brief generator.
 *
 * It takes no model: `ctx.generate` is the SDK's one-shot generation
 * capability, and it already resolves the agent's own LLM on the agent's own
 * credentials and cancels with the call. Threading a `LanguageModel` in here
 * was a second, parallel way to reach the same model — and the one that could
 * drift from it.
 */
export function createDesignInspirationTool(): Record<string, ToolDef> {
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
      execute: async ({ goal, context }, ctx) => {
        try {
          const { text } = await ctx.generate({
            system: DESIGN_BRIEF_SYSTEM,
            prompt: `Goal: ${goal}${context ? `\nContext: ${context}` : ""}`,
          });
          return text;
        } catch (err) {
          return `Error: ${errorMessage(err)}`;
        }
      },
    }),
  };
}
