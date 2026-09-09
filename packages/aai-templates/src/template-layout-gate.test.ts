// Copyright 2026 the AAI authors. MIT license.
/**
 * A template's LAYOUT is decided by its front door, and three parts of that were
 * carried by habit.
 *
 * `agent-templates` and `template-eval-spec` already pin what every template
 * has — `agent.ts`, the two specs, a `tools/` file that default-exports its
 * tool. What neither can say is anything CONDITIONAL on what the agent is,
 * because konsistent's vocabulary has no content predicate and no negative file
 * assertion: its `if` supports `hasFile` and nothing else. So the three rules
 * below were true of all 28 templates and enforced by none of them.
 *
 * ## 1. A `workflowApp()` has no model turn, so two files there are unreachable
 *
 * `workflowApp` takes `StaticAgentParams` — no `llm`, no `stt`, no `tts` — so
 * there is no turn for a model to take. A `tools/` file in one is discovered by
 * the bundler, shipped in the guest bundle, and callable by nobody; a
 * `system-prompt.md` beside it is read by nothing at all.
 *
 * Both ARE caught today, and that is the reason this exists rather than a
 * reason it does not need to. A/B'd by planting each in `document-redline-workflow`: konsistent
 * fails with `Missing import from "virtual:aai/agent"` against
 * `agent.eval.test.ts` — the `eval-drives-the-discovered-*` rules flip on the
 * moment a template gains discoverable content, so the shape is defended and
 * the diagnosis names the wrong file. An author reads that error and edits
 * their eval.
 *
 * ## 2. Where a workflow DEF is declared follows from who has to import it
 *
 * Eight templates declare a `workflow({ … })`, and the split is exact: the six
 * `workflowApp()`s declare it in `agent.ts`, and the two voice agents that hand
 * off — `meeting-recap-agent`, `research-handoff-agent` — declare it in `shared.ts`,
 * where eight of their tools import it from.
 *
 * That is forced by the layering rather than chosen: a workflow app has no
 * `tools/`, so nothing but `agent.ts` needs the def, while a voice agent's
 * tools do — and `virtual:aai/agent` is `agent.ts` PLUS a static import of
 * every `tools/` file, so a tool importing `agent.ts` closes a cycle through
 * it. No template does that.
 *
 * The rule was already written down twice, and both copies described the
 * majority instead of the cause: this package's guide said of
 * `research-handoff-agent` that "`agent.ts` holds the declaration … and nothing else
 * about the run", and that file's own module doc said "this module declares the
 * agent and the workflow it hands off to". Neither was true of the file. Both
 * are corrected in the same change as this gate.
 *
 * ## 3. A session slot is declared in `shared.ts`
 *
 * Fourteen of the fifteen stateful templates declare `sessionSlot()` there, and
 * `retail-orders-agent` is the exception FOR A REASON that is easy to copy without: its slot
 * sits in `store.ts` because that module imports a 107 KB `seed.json`, and
 * `shared.ts` — which the browser half imports for the view — must not pull it.
 * An exemption with its reason attached is the point of listing it here rather
 * than leaving the rule unwritten.
 *
 * ## Floors, because the success output is a count
 *
 * The corpus is discovered by walking `templates/`, so a rename would make every
 * per-template claim vacuous by having none to make. Each set is floored under
 * its measured actual — under rather than at, so adding a template is not an
 * edit here.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/** The PACKAGE root: `templates/` sits beside `src/`. */
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES_DIR = path.join(HERE, "templates");

/** `workflowApp(` and not `workflow(` — the `App` is what tells them apart. */
const DECLARES_WORKFLOW_APP = /\bworkflowApp\s*\(/;

/**
 * A workflow DECLARATION, which `workflowApp(` must not satisfy.
 *
 * `\bworkflow\s*\(` cannot match `workflowApp(`: the character after `workflow`
 * is `A`, not a paren or a space. Asserted below rather than reasoned about.
 */
const DECLARES_WORKFLOW = /\bworkflow\s*\(\s*\{/;

/** A slot declaration, wherever it is. */
const DECLARES_SLOT = /\bsessionSlot\s*\(/;

/**
 * The templates whose slot is not in `shared.ts`, and why.
 *
 * A DENY-list, so a new template defaults into being checked. Deleting an entry
 * is how this narrows; adding one asks for the same argument again.
 *
 * Both entries are the SAME failure, and it is a measured one rather than a
 * stylistic preference: a slot holds its factory as a live reference, so nothing
 * tree-shakes it, and `shared.ts` is the module `client.tsx` imports for its
 * view. Put a seeded factory there and the seed ships to the browser. Verified
 * on the built client bundle before hotel-reception-agent was split: all 43 of
 * `seed.ts`'s guest phone numbers were present in it.
 */
const SLOT_ELSEWHERE: Readonly<Record<string, string>> = {
  "retail-orders-agent":
    "its slot is in store.ts, which imports a 107 KB seed.json — shared.ts holds " +
    "the view and is imported by client.tsx, so the seed must not reach it",
  "hotel-reception-agent":
    "its slot is in session.ts, whose factory reaches an 18.5 KB seed.ts on top " +
    "of records.ts — shared.ts holds the view and is imported by client.tsx, so " +
    "the seed must not reach it",
};

/** Floors, set under the measured actuals: 28 templates, 6 apps, 15 stateful. */
const MIN_TEMPLATES = 20;
const MIN_WORKFLOW_APPS = 4;
const MIN_STATEFUL = 10;

function templateNames(): string[] {
  return readdirSync(TEMPLATES_DIR)
    .filter((name) => statSync(path.join(TEMPLATES_DIR, name)).isDirectory())
    .sort();
}

/**
 * A module's CODE, with its comments removed.
 *
 * Every pattern here would otherwise match prose. `research-handoff-agent/agent.ts`
 * is the case that proved it: its module doc explains that a form-shaped
 * product "is declared with `workflowApp()` instead", so a plain read reported
 * this voice agent as a workflow app and the gate demanded it delete its own
 * `tools/`. Same trap `template-durability-gate.test.ts` records for
 * `runWorkflow`, met from the other direction.
 *
 * Block comments go whole; a line comment is stripped only where `//` OPENS the
 * line, so a `https://` inside a string literal is left alone.
 */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function read(name: string, file: string): string {
  const at = path.join(TEMPLATES_DIR, name, file);
  return existsSync(at) ? codeOf(readFileSync(at, "utf8")) : "";
}

function has(name: string, entry: string): boolean {
  return existsSync(path.join(TEMPLATES_DIR, name, entry));
}

/** Root `.ts` modules, which is where a slot or a workflow def is declared. */
function rootModules(name: string): string[] {
  return readdirSync(path.join(TEMPLATES_DIR, name)).filter(
    (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
  );
}

const ALL = templateNames();
const WORKFLOW_APPS = ALL.filter((name) => DECLARES_WORKFLOW_APP.test(read(name, "agent.ts")));
const STATEFUL = ALL.filter((name) =>
  rootModules(name).some((file) => DECLARES_SLOT.test(read(name, file))),
);

describe("the corpus this gate walks", () => {
  test("finds the templates, the workflow apps, and the stateful ones", () => {
    // A walk that found nothing would satisfy every per-template claim below by
    // having none to make — the failure this whole file is shaped against.
    expect(ALL.length).toBeGreaterThanOrEqual(MIN_TEMPLATES);
    expect(WORKFLOW_APPS.length).toBeGreaterThanOrEqual(MIN_WORKFLOW_APPS);
    expect(STATEFUL.length).toBeGreaterThanOrEqual(MIN_STATEFUL);
  });

  test("every template has an agent.ts with something in it", () => {
    for (const name of ALL) expect(read(name, "agent.ts").length, name).toBeGreaterThan(0);
  });

  test("reads CODE, not prose — the trap this gate walked into first", () => {
    // A/B: before `codeOf`, research-handoff-agent's module doc — which names
    // `workflowApp()` to explain what it is NOT — reported it as one, and the
    // gate told a voice agent to delete its tools/.
    const doc = "/** the agent is declared with `workflowApp()` instead */\nexport default agent({";
    expect(DECLARES_WORKFLOW_APP.test(doc)).toBe(true);
    expect(DECLARES_WORKFLOW_APP.test(codeOf(doc))).toBe(false);
    // And a URL in a string survives, so stripping cannot eat code.
    expect(codeOf('const u = "https://x.test/a";')).toContain("https://x.test/a");
  });

  test("the two workflow patterns are distinguishable, which the whole file rests on", () => {
    // `workflowApp({ … })` must NOT read as a workflow declaration, or rule 2
    // would ask every app to declare its def somewhere it does not.
    expect(DECLARES_WORKFLOW.test("export default workflowApp({ name: 'x' });")).toBe(false);
    expect(DECLARES_WORKFLOW.test("export const d = workflow({ input: x });")).toBe(true);
    expect(DECLARES_WORKFLOW_APP.test("export default workflowApp({ name: 'x' });")).toBe(true);
  });
});

describe.each(WORKFLOW_APPS)("%s (a workflow app)", (name: string) => {
  test("ships no tools/ and no system-prompt.md, which it could not reach", () => {
    expect(
      has(name, "tools"),
      `${name} is a workflowApp() — StaticAgentParams, so no llm/stt/tts and no model ` +
        "turn — but ships a tools/ directory. Those tools are discovered by the bundler " +
        "and callable by nobody. Delete them, or make this a voice agent().",
    ).toBe(false);
    expect(
      has(name, "system-prompt.md"),
      `${name} is a workflowApp() and has a system-prompt.md, which nothing reads: ` +
        "a static page has no prompt. `withSystemPrompt` cannot catch this — it fires " +
        "on an agent whose prompt is the framework default, and this one has none.",
    ).toBe(false);
  });

  test("has the two halves a workflow app IS", () => {
    expect(has(name, "client.tsx"), `${name} is a workflowApp() with no client.tsx`).toBe(true);
    expect(has(name, "workflows"), `${name} is a workflowApp() with no workflows/`).toBe(true);
  });
});

describe("where a workflow def is declared", () => {
  const declarers = ALL.filter((name) =>
    rootModules(name).some((file) => DECLARES_WORKFLOW.test(read(name, file))),
  );

  test("some template declares one", () => {
    expect(declarers.length).toBeGreaterThanOrEqual(MIN_WORKFLOW_APPS);
  });

  test.each(declarers)("%s declares it where its importers can reach it", (name: string) => {
    const inAgent = DECLARES_WORKFLOW.test(read(name, "agent.ts"));
    if (has(name, "tools")) {
      expect(
        inAgent,
        `${name} has tools/ and declares its workflow in agent.ts. Its tools need the ` +
          "def, and `virtual:aai/agent` is agent.ts PLUS a static import of every tools/ " +
          "file — so importing it back from a tool closes a cycle through that module. " +
          "Declare the def in shared.ts, as meeting-recap-agent and research-handoff-agent do.",
      ).toBe(false);
    } else {
      expect(
        inAgent,
        `${name} has no tools/, so nothing but agent.ts needs its workflow def — ` +
          "declare it there, beside the app, as `workflowApp`'s own @example does.",
      ).toBe(true);
    }
  });
});

describe.each(STATEFUL)("%s (stateful)", (name: string) => {
  test("declares its session slot in shared.ts", () => {
    const elsewhere = SLOT_ELSEWHERE[name];
    const inShared = DECLARES_SLOT.test(read(name, "shared.ts"));
    if (elsewhere !== undefined) {
      // The exemption is CHECKED, not merely granted: a template listed here
      // whose slot moved back into shared.ts should lose its entry, so the
      // deny-list only ever narrows.
      expect(
        inShared,
        `${name} is exempt from the shared.ts rule (${elsewhere}) but declares its slot ` +
          "there anyway — remove it from SLOT_ELSEWHERE.",
      ).toBe(false);
      return;
    }
    expect(
      inShared,
      `${name} declares a sessionSlot outside shared.ts. Every stateful template keeps ` +
        "the slot, the view and the projection in one module both ends import — see " +
        "`useAgentState(projection)`. If a SEEDED factory forces it elsewhere (the two " +
        "cases: retail-orders-agent and hotel-reception-agent, whose factories reach a " +
        "seed the browser must not take), add it to SLOT_ELSEWHERE with that reason.",
    ).toBe(true);
  });
});
