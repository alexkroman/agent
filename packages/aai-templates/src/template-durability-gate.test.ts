// Copyright 2026 the AAI authors. MIT license.
/**
 * A template that declares a WORKFLOW must exercise its body durably.
 *
 * ## The gap this closes, and how it was found
 *
 * `@alexkroman1/aai-runtime/testing` publishes `runWorkflow` — the real replay
 * engine over an in-memory journal, so a spec can assert that a run suspended,
 * resumed off its journal, retried, was answered, and survived a dead worker.
 * When it landed, exactly ONE of the eight templates with a `workflows/`
 * directory used it, and every gate in the repo was satisfied:
 * `template-api-coverage.test.ts` asks that each published export be exercised
 * SOMEWHERE in the corpus, which one worked example does.
 *
 * That is the shape this repo keeps paying for from a new direction — a
 * capability published, one example written, and a ratchet that reports green
 * over seven templates whose central promise is untested. Nothing would have
 * stopped the ninth template shipping the same way.
 *
 * ## What it asks for, and what it deliberately does not
 *
 * A template with a `workflows/` directory must CALL `runWorkflow` from one of
 * its own specs. That is a floor on the kind of claim the file makes, not on its
 * coverage: `call-audit`'s first step runs ffmpeg, which this repo's test
 * environment does not have, so its durable block asserts what is reachable (a
 * `FatalError` failing a run on one attempt of six) and says so. A gate that
 * demanded a full run would have that template lying instead.
 *
 * The import is not enough — the CALL is checked. An import that survived a
 * deleted block is exactly how this gate would come to pass over nothing.
 *
 * ## Floors, because the success output is a count
 *
 * The corpus is discovered by walking `templates/`, so a rename or a moved
 * directory makes it zero and the gate would print a checkmark over an empty
 * set. Both halves are floored: how many templates declare a workflow at all,
 * and how many spec files were read looking for the call.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/** The PACKAGE root: `templates/` and the allowlist sit beside `src/`. */
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES_DIR = path.join(HERE, "templates");

/** The subpath a durable body spec is written against. */
const SURFACE = "@alexkroman1/aai-runtime/testing";

/**
 * An IMPORT of it, not a mention.
 *
 * A plain substring matches the module doc of every template that explains why
 * its durable block exists — which is prose, and prose is not coverage. A/B'd:
 * deleting redline's import while its doc still named the subpath left a bare
 * `includes` green. Same trap `check-escape-hatches` records for markdown, and
 * the reason `check-authoring-guide` looks at CODE spans only.
 */
const IMPORTS_SURFACE = /from\s+["']@alexkroman1\/aai-runtime\/testing["']/;

/** A CALL of it. An import a deleted block left behind is not a spec. */
const CALLS_RUN_WORKFLOW = /\brunWorkflow\s*\(/;

/**
 * Floors, set under the measured actuals: 8 templates with a `workflows/`
 * directory, and 26 templates in all.
 *
 * Under rather than at, so adding a template is not an edit here — what these
 * catch is the walk finding NOTHING, which is what a rename of `templates/` or
 * of `workflows/` would produce.
 */
const MIN_WORKFLOW_TEMPLATES = 6;
const MIN_TEMPLATES = 20;

/** Every template directory, by name. */
function templateNames(): string[] {
  return readdirSync(TEMPLATES_DIR).filter((name) =>
    statSync(path.join(TEMPLATES_DIR, name)).isDirectory(),
  );
}

/** Templates that declare a workflow — the ones this gate is about. */
function workflowTemplates(): string[] {
  return templateNames().filter((name) => existsSync(path.join(TEMPLATES_DIR, name, "workflows")));
}

/** Every `*.test.ts` a template owns, EXCLUDING its eval tier. */
function specsOf(name: string): string[] {
  const dir = path.join(TEMPLATES_DIR, name);
  return readdirSync(dir)
    .filter((file) => file.endsWith(".test.ts") && !file.endsWith(".eval.test.ts"))
    .map((file) => path.join(dir, file));
}

describe("the corpus this gate walks", () => {
  test("finds the templates, and the ones that declare a workflow", () => {
    // A walk that found nothing would satisfy every per-template claim below by
    // having none to make — the failure this whole file is shaped against.
    expect(templateNames().length).toBeGreaterThanOrEqual(MIN_TEMPLATES);
    expect(workflowTemplates().length).toBeGreaterThanOrEqual(MIN_WORKFLOW_TEMPLATES);
  });

  test("reads a spec file for every one of them", () => {
    const read = workflowTemplates().flatMap(specsOf);
    expect(read.length).toBeGreaterThanOrEqual(MIN_WORKFLOW_TEMPLATES);
    // And each one is non-empty, so a spec that became unreadable cannot pass by
    // matching nothing.
    for (const file of read) expect(readFileSync(file, "utf8").length).toBeGreaterThan(0);
  });
});

describe.each(workflowTemplates())("%s", (name: string) => {
  test("drives its workflow body on the real engine", () => {
    const sources = specsOf(name).map((file) => readFileSync(file, "utf8"));
    expect(sources.length, `${name} declares a workflow but ships no spec`).toBeGreaterThan(0);

    const imports = sources.filter((source) => IMPORTS_SURFACE.test(source));
    expect(
      imports.length,
      `${name} declares a workflow in workflows/ but no spec imports ${SURFACE}. ` +
        "A template's body is the thing the template is FOR, and `createWorkflowCtx` " +
        "records what it asked for without replaying anything — see " +
        "link-digest/agent.test.ts for the shape a durable block takes.",
    ).toBeGreaterThan(0);

    // The CALL, not the import: a block that was deleted leaving its import
    // behind is exactly how this gate would come to pass over nothing.
    const drives = sources.filter((source) => CALLS_RUN_WORKFLOW.test(source));
    expect(
      drives.length,
      `${name} imports ${SURFACE} but never calls runWorkflow(...)`,
    ).toBeGreaterThan(0);
  });
});
