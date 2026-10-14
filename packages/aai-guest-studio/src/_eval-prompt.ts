// Copyright 2026 the AAI authors. MIT license.
/**
 * What the studio SENDS a coding-agent session, for the eval that grades against
 * it: the shipped system prompt, and the shipped starter catalog.
 *
 * `studio/_eval-harness.ts` runs the coding agent on `STUDIO_EVAL_PROMPT`, a
 * four-line harness constant, and that is right for the cases whose subject is
 * the guest's own surfaces — a tool's refusal wording, its result prose. It is
 * exactly wrong for a case whose subject is an OUTCOME: what the studio produces
 * from a starter prompt is very largely a measurement of the studio's own
 * prompt, and grading that against the harness constant measures a string
 * nobody ships. The repo's template evals already say so at the seam where it
 * would be forgotten:
 *
 *     an eval run against the framework default prompt measures an agent
 *     nobody deployed
 *     — templates/text-adventure-agent/agent.eval.test.ts
 *
 * ## Why a file on disk rather than an import
 *
 * The shipped prompt is `studioSystemPrompt()` in `aai-studio-server`, and
 * this package cannot import it — not merely because `guest-package-boundary`
 * says so, but because `aai-server` depends on `aai-guest` (it resolves the
 * built harness artifact), so the edge would close the cycle `aai-guest` →
 * `aai-studio-server` → `aai-server` → `aai-guest`, and `turbo.json`'s `build`
 * is `dependsOn: ["^build"]`. That is a task-graph error, not a lint opinion.
 *
 * Nothing is lost by reading it as data, because **data is what it is in
 * production too**: `studio-session-ensure.ts` puts the composed prompt in the
 * session-init payload, and `studio/session.ts` appends `toolchainPromptSection()`
 * to whatever arrives over the wire. The guest never composes this string; it
 * runs it. So the copies under `studio-prompts/` are the runtime arrangement,
 * written by `scripts/sync-studio-prompt.mjs` and held current by
 * `check:studio-prompt` — the same shape `sync-agent-guide.mjs` uses for the
 * authoring guide, and the same shape a template eval already gets its prompt
 * through (`system-prompt.md`, reaching `virtual:aai/agent` as a build artifact
 * rather than as an import of whatever composed it).
 *
 * ## A missing copy THROWS
 *
 * It does not fall back to {@link STUDIO_EVAL_PROMPT}. A case that asked for the
 * shipped prompt and silently got the harness one is the failure this module
 * exists to remove, arriving from the inside and reporting green — which is the
 * single failure shape the whole eval tier is written against.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Where `scripts/sync-studio-prompt.mjs` writes the copies. */
const PROMPTS_DIR = new URL("../studio-prompts/", import.meta.url);

/** The prompt copy's file name inside {@link PROMPTS_DIR}. */
const PROMPT_FILE = "system-prompt.md";

/**
 * The generated banner, which is NOT part of the prompt.
 *
 * Stripped by locating the comment's end rather than by counting lines, and only
 * when the file actually opens with one — a copy someone hand-wrote without the
 * banner is returned whole rather than having its first paragraph eaten.
 */
const BANNER = /^<!--[\s\S]*?-->\n+/;

/** Read once: the file is ~150KB and a case may ask repeatedly. */
let promptCache: string | undefined;

/**
 * The system prompt the studio really sends a coding-agent session.
 *
 * The HOST half only, which is the half that is a host artifact: the guest
 * appends `toolchainPromptSection()` itself, inside `initStudioSession`, in an
 * eval exactly as in production. Appending it here would double it.
 */
export function shippedStudioPrompt(
  /**
   * Where to look. Defaults to the committed copy; a spec passes a directory
   * that HAS no copy, which is how the not-on-disk branch is reached without a
   * cast and without writing a file (a unit test may read, never write).
   * `loadScaffoldGuide(guidePath = scaffoldGuidePath())` in aai-studio-server
   * is the same shape for the same reason.
   */
  promptsDir: URL = PROMPTS_DIR,
): string {
  const memoize = promptsDir.href === PROMPTS_DIR.href;
  if (memoize && promptCache !== undefined) return promptCache;

  const file = new URL(PROMPT_FILE, promptsDir);
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch (error) {
    throw new Error(
      `the shipped studio prompt is not on disk at ${fileURLToPath(file)}. It is a ` +
        "generated copy of studioSystemPrompt() in aai-studio-server — run " +
        "`node scripts/sync-studio-prompt.mjs` and commit the result. " +
        "This case asked for the SHIPPED prompt and will not silently run on " +
        "the harness's instead.",
      { cause: error },
    );
  }

  const prompt = raw.replace(BANNER, "");
  if (prompt.trim() === "") {
    throw new Error(
      `the shipped studio prompt is empty at ${fileURLToPath(file)} — ` +
        "run `node scripts/sync-studio-prompt.mjs`.",
    );
  }
  if (memoize) promptCache = prompt;
  return prompt;
}

/** Test-only: drop the memoized prompt and starters. */
export function _resetShippedStudioPromptCache(): void {
  promptCache = undefined;
  starterCache = undefined;
}

/** One entry of the studio's new-project catalog. */
export type StudioStarter = { readonly label: string; readonly prompt: string };

/** The catalog as `sync-studio-prompt.mjs` writes it, plus its banner key. */
type StarterFile = { readonly _generated?: string; readonly starters?: unknown };

/** Where the catalog copy lives. */
const STARTERS_FILE = new URL("starters.json", PROMPTS_DIR);

/** Read once — the file is small, but a case asks per starter. */
let starterCache: StarterFile | undefined;

/**
 * The starters the studio's new-project screen really offers.
 *
 * Read rather than restated, for {@link shippedStudioPrompt}'s reason one level
 * out: a starter's `prompt` is the user turn a case drives, so a copy typed here
 * would let the eval keep grading a prompt the product stopped offering — and
 * pass while doing it.
 */
export function studioStarters(
  /** Where to read the catalog. See {@link shippedStudioPrompt}'s `promptsDir`. */
  file: URL = STARTERS_FILE,
): readonly StudioStarter[] {
  const read = (): StarterFile => JSON.parse(readFileSync(file, "utf-8")) as StarterFile;
  let parsed: StarterFile;
  if (file.href === STARTERS_FILE.href) {
    starterCache ??= read();
    parsed = starterCache;
  } else {
    // A lookaside read is never memoized: a spec pointing at another file must
    // not be able to poison the catalog the harness reads.
    parsed = read();
  }
  const list = parsed.starters;
  if (!isStarterList(list) || list.length === 0) {
    throw new Error(
      `no starters in ${fileURLToPath(file)} — run ` +
        "`node scripts/sync-studio-prompt.mjs` and commit the result.",
    );
  }
  return list;
}

/** Every entry carries a string label and prompt — the shape a case drives. */
function isStarterList(value: unknown): value is StudioStarter[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        "label" in entry &&
        typeof entry.label === "string" &&
        "prompt" in entry &&
        typeof entry.prompt === "string",
    )
  );
}

/**
 * One starter by label, or a throw naming the labels there are.
 *
 * A case names the starter it grades, and the label is the studio's own — so a
 * starter renamed or retired in `aai-studio-client` FAILS the case that graded
 * it, rather than leaving it quietly grading a prompt string frozen in this
 * repository. That is the whole reason the catalog is synced instead of inlined.
 */
export function studioStarter(label: string): StudioStarter {
  const found = studioStarters().find((starter) => starter.label === label);
  if (found === undefined) {
    throw new Error(
      `no starter labelled ${JSON.stringify(label)}. The studio offers: ` +
        `${studioStarters()
          .map((s) => JSON.stringify(s.label))
          .join(", ")}. A renamed starter fails here on purpose — update the case ` +
        "rather than inlining the prompt.",
    );
  }
  return found;
}
