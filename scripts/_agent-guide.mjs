// Copyright 2026 the AAI authors. MIT license.
/**
 * The agent-authoring guide as a SET of files, and the subpath list generated
 * into it — shared by `sync-agent-guide.mjs` (which writes and checks the
 * copies) and `check-authoring-guide.mjs` (which reads the whole guide).
 *
 * ## Layout
 *
 * The source lives in the scaffold, so it ships wherever the scaffold does (the
 * CLI tarball's `dist/scaffold`, the studio's `scaffoldDir()`):
 *
 *   packages/aai-templates/scaffold/CLAUDE.md               the CORE guide
 *   packages/aai-templates/scaffold/agent-guide/<TOPIC>.md  topic references
 *
 * and is copied into the SDK tarball with the same relative layout, so a link
 * from the core to `agent-guide/TOOLS.md` resolves in both places:
 *
 *   packages/aai/AGENT_GUIDE.md
 *   packages/aai/agent-guide/<TOPIC>.md
 *
 * A project gets NEITHER copied: `layerScaffoldFiles` skips the core and the
 * topic directory and writes a pointer at the SDK copy instead, which is
 * version-matched by construction.
 *
 * ## The generated subpath list
 *
 * `SUBPATHS` says what each `@alexkroman1/aai` export is FOR. The list it
 * renders replaces a hand-kept one in `packages/aai/skills/aai/SKILL.md` that
 * named a `/runtime` subpath for as long as that subpath had been gone. The
 * record must cover the `exports` map exactly — a new export without an entry,
 * or an entry for a removed one, fails `check:agent-guide`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { repoRoot } from "./_fs.mjs";

export const ROOT = repoRoot(import.meta.url).replace(/\/$/, "");

/** Where the guide is authored. */
export const SOURCE_DIR = join(ROOT, "packages/aai-templates/scaffold");
/** Where the copies ship. */
export const SDK_DIR = join(ROOT, "packages/aai");
/** The core guide, relative to {@link SOURCE_DIR}. */
export const CORE_SOURCE = "CLAUDE.md";
/** The core guide's published name, relative to {@link SDK_DIR}. */
export const CORE_DESTINATION = "AGENT_GUIDE.md";
/** The topic directory — the same relative name on both sides. */
export const TOPIC_DIR = "agent-guide";
/** The thin skill whose subpath list is generated. */
export const SKILL_PATH = join(SDK_DIR, "skills/aai/SKILL.md");

/**
 * Size caps, in characters. The core is what every agent reads first, so it is
 * held to a budget well under the old single file; a topic is read on demand.
 */
export const CORE_BUDGET = 20_000;
export const TOPIC_BUDGET = 50_000;

/** Every topic file name, sorted — read from the directory, never listed. */
export function topicFiles() {
  return readdirSync(join(SOURCE_DIR, TOPIC_DIR))
    .filter((name) => name.endsWith(".md"))
    .sort();
}

/**
 * Every guide file as `{ source, destination, text }`, core first. `source` and
 * `destination` are absolute.
 */
export function guideFiles() {
  return [
    { source: join(SOURCE_DIR, CORE_SOURCE), destination: join(SDK_DIR, CORE_DESTINATION) },
    ...topicFiles().map((name) => ({
      source: join(SOURCE_DIR, TOPIC_DIR, name),
      destination: join(SDK_DIR, TOPIC_DIR, name),
    })),
  ].map((file) => ({ ...file, text: readFileSync(file.source, "utf8") }));
}

/** The whole guide as one string — what a corpus check over "the guide" reads. */
export function wholeGuide() {
  return guideFiles()
    .map((file) => file.text)
    .join("\n");
}

/**
 * What each `@alexkroman1/aai` export is for. `audience: "author"` entries are
 * listed for someone writing an agent; `"host"` ones are listed under a
 * separate heading, since an `agent.ts` never imports them.
 */
export const SUBPATHS = {
  ".": {
    audience: "author",
    use: "declaring the agent: `agent`, `tool`, `clientTool`, `sessionSlot`, `dialog`, `procedure`, `workflow`, `workflowApp`, `speaker`, `roster`, the speech helpers, and their types",
  },
  "./utils": {
    audience: "author",
    use: "zero-dependency helpers for a tool body, a step or a client — `isToolFailure`, `createKeyedLock`, `pushCapped`, `errorMessage`, `omitUndefined`",
  },
  "./tools": {
    audience: "author",
    use: "calling `webSearch`, `visitWebpage` or `fetchJson` from your own tool code",
  },
  "./stt": {
    audience: "author",
    use: "an STT provider for a pipeline stage (`assemblyAIStt`, `deepgramStt`, …)",
  },
  "./llm": {
    audience: "author",
    use: "an LLM provider for a pipeline stage (`llm({ provider, model })`)",
  },
  "./tts": {
    audience: "author",
    use: "a TTS provider for a pipeline stage (`assemblyAITts`, `cartesiaTts`, `rimeTts`)",
  },
  "./s2s": {
    audience: "author",
    use: "a speech-to-speech provider (`assemblyAIS2s`, `openAIS2s`)",
  },
  "./step": {
    audience: "author",
    use: "step code in `workflows/*.ts` — `stepEnv`, `stepFetch`, `stepGenerate`, transcription, `stepSpeak`, uploads, `mapConcurrent`, `stepPlaceCall`",
  },
  "./step-errors": {
    audience: "author",
    use: "`orFail` around a step call, and `FatalError`/`RetryableError` classification",
  },
  "./step-files": {
    audience: "author",
    use: "streaming an upload too big for memory to disk inside a step",
  },
  "./ffmpeg": { audience: "author", use: "running ffmpeg or probing media from a step" },
  "./html": { audience: "author", use: "reading a fetched page or RSS/Atom feed (Node-only)" },
  "./channels": { audience: "author", use: "posting a run's result to Slack or SMS" },
  "./workflow-api": {
    audience: "author",
    use: "a page, script or cron job calling a deployed agent's workflow API",
  },
  "./testing": {
    audience: "author",
    use: "specs — `runTool`, `createToolContext`, `deployedAgent`, `expectDeployable`, and the step stubs",
  },
  "./testing/vitest": {
    audience: "author",
    use: "the vitest-only half of `/testing`: anything that installs or restores a stub",
  },
  "./testing/vite": {
    audience: "author",
    use: "the plugin `vitest.config.ts` registers to serve `virtual:aai/agent`",
  },
  "./tsconfig": {
    audience: "author",
    use: "the tsconfig preset a project's `tsconfig.json` extends",
  },
  "./experimental": {
    audience: "author",
    use: "unstable integrations (Composio, deep-research helpers) — may change in any release",
  },
  "./coding-tools": {
    audience: "host",
    use: "the workspace tool set for a `text: true` agent that edits code (`templates/coding-agent`)",
  },
  "./protocol": { audience: "host", use: "the client/server wire protocol" },
  "./manifest": { audience: "host", use: "the build's agent-manifest lowering" },
  "./workspace-files": {
    audience: "host",
    use: "what a project's files are, for the CLI and studio",
  },
  "./slugify": { audience: "host", use: "the platform's slug rule" },
  "./internal": { audience: "host", use: "framework internals" },
  "./host-internal": { audience: "host", use: "framework internals for the host runtime" },
};

/** `"./utils"` → `"@alexkroman1/aai/utils"`. */
export function specifierOf(key, name = "@alexkroman1/aai") {
  return key === "." ? name : `${name}/${key.replace(/^\.\//, "")}`;
}

/** The `@alexkroman1/aai` manifest's `exports` keys. */
export function sdkExportKeys() {
  const manifest = JSON.parse(readFileSync(join(SDK_DIR, "package.json"), "utf8"));
  return Object.keys(manifest.exports ?? {});
}

/** Problems between {@link SUBPATHS} and the exports map, as sentences. */
export function subpathProblems(keys = sdkExportKeys()) {
  const problems = [];
  for (const key of keys) {
    if (!Object.hasOwn(SUBPATHS, key)) {
      problems.push(
        `\`${specifierOf(key)}\` is exported by packages/aai/package.json but has no entry in ` +
          "SUBPATHS (scripts/_agent-guide.mjs) — say what it is for, and whether an author imports it.",
      );
    }
  }
  for (const key of Object.keys(SUBPATHS)) {
    if (!keys.includes(key)) {
      problems.push(
        `SUBPATHS (scripts/_agent-guide.mjs) describes \`${specifierOf(key)}\`, which ` +
          "packages/aai/package.json no longer exports — remove the entry.",
      );
    }
  }
  return problems;
}

/** The generated block's markers, around the list in every file that carries one. */
export const BLOCK_BEGIN = "<!-- BEGIN GENERATED aai subpaths: pnpm sync:agent-guide -->";
export const BLOCK_END = "<!-- END GENERATED aai subpaths -->";

/** The markdown line width `.markdownlint-cli2.jsonc` enforces (MD013). */
const WIDTH = 80;

/**
 * Wrap one paragraph or list item at {@link WIDTH}, never inside a code span,
 * continuing with `indent` — so the generated block passes markdownlint and is
 * already in the shape Prettier leaves alone.
 */
function wrap(text, indent = "") {
  const words = [];
  for (const word of text.split(" ")) {
    const last = words.at(-1);
    // Inside an unclosed code span: keep the space, do not break here.
    if (last !== undefined && (last.match(/`/g) ?? []).length % 2 === 1) {
      words[words.length - 1] = `${last} ${word}`;
    } else {
      words.push(word);
    }
  }
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current === "" ? word : `${current} ${word}`;
    if (next.length > WIDTH && current !== "" && current !== indent.trimEnd()) {
      lines.push(current);
      current = `${indent}${word}`;
    } else {
      current = next;
    }
  }
  if (current !== "") lines.push(current);
  return lines.join("\n");
}

/**
 * The list itself, in `exports` order, authors first. `detail: false` (the
 * core guide, which has a size budget) names the host subpaths in one line
 * instead of describing each.
 */
export function renderSubpathBlock(keys = sdkExportKeys(), { detail = true } = {}) {
  const line = (key) =>
    wrap(`- \`${specifierOf(key)}\` — ${SUBPATHS[key]?.use ?? "(undocumented)"}`, "  ");
  const author = keys.filter((key) => SUBPATHS[key]?.audience === "author");
  const host = keys.filter((key) => SUBPATHS[key]?.audience === "host");
  const hostPart = detail
    ? [
        wrap(
          "Not imported by an `agent.ts` (hosts, the CLI and the studio; not covered by " +
            "semver for authors):",
        ),
        "",
        ...host.map(line),
      ]
    : [
        wrap(
          `Framework-internal, never imported by an \`agent.ts\`: ${host
            .map((key) => `\`${key.slice(1)}\``)
            .join(", ")}.`,
        ),
      ];
  return [BLOCK_BEGIN, "", ...author.map(line), "", ...hostPart, "", BLOCK_END].join("\n");
}

/**
 * `text` with its generated block replaced, or `null` when it has none (or a
 * malformed one) — a file that is supposed to carry the block and lost its
 * markers is a failure, not a no-op.
 */
export function withSubpathBlock(text, block = renderSubpathBlock()) {
  const start = text.indexOf(BLOCK_BEGIN);
  const end = text.indexOf(BLOCK_END);
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(0, start) + block + text.slice(end + BLOCK_END.length);
}

/**
 * Exit when a topic file is missing from `check-doc-examples.mjs`'s literal
 * `MARKDOWN_FILES`, so a new one cannot default OUT of that gate the way a new
 * docs page once could.
 *
 * @param {readonly string[]} listed repo-relative paths
 */
export function assertEveryGuideFileListed(listed) {
  const missing = topicFiles()
    .map((name) => relative(ROOT, join(SOURCE_DIR, TOPIC_DIR, name)))
    .filter((file) => !listed.includes(file));
  if (missing.length === 0) return;
  console.error(
    "check-doc-examples: authoring-guide topic file(s) missing from MARKDOWN_FILES:\n" +
      missing.map((file) => `  ${file}`).join("\n") +
      "\nAdd each as a literal line — the gate specs read the list off that file.",
  );
  process.exit(1);
}
