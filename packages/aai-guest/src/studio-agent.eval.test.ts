// Copyright 2026 the AAI authors. MIT license.
// An EVAL of the studio's coding agent: given this instruction and this
// workspace, did it do the right thing?
//
// `studio-agent.test.ts` asserts what the DEFINITION declares (text mode, the
// four tool families, the labels, the deadline). `studio-tools.test.ts` drives
// each tool directly. `studio-chat.scenario.test.ts` drives the HTTP surface
// with a scripted model. None of them can say whether the AGENT — a model,
// reading these tool descriptions, holding these twenty-three tools over a real
// workspace — reaches for the right one, in the right order, and leaves a tree
// that actually compiles. That is what this file is for, and it is the same
// question, asked with the same suite, that the twenty-five shipped template
// evals ask of a voice agent.
//
// `_studio-eval-harness.ts` carries the whole account of what is real in a case
// and what is not. The one limit to keep in mind while reading a result: the
// system prompt here is the HARNESS's, because the shipped one lives in
// `aai-studio-server` and this package may not import it. So these cases
// adjudicate the tool set, the tools' own answers and the model. The studio's
// prompt is graded by the HTTP starter eval in `aai-evals`, and by nothing here.
//
// ```sh
// pnpm test:eval --filter aai-guest                       # live, spends tokens
// AAI_EVAL_STUB=1 pnpm --filter aai-guest test:eval        # wiring only
// pnpm --filter aai-guest test:eval -- -t "type-clean"     # one case
// ```

import path from "node:path";
import {
  describeTurn,
  type EvalToolCall,
  toolCallsInTurns,
  toolNames,
} from "@alexkroman1/aai-runtime/eval";
import { expect } from "vitest";
import { describeStudioEval, type StudioEvalContext } from "./_studio-eval-harness.ts";

// ---- fixtures ---------------------------------------------------------------

/** A workspace that already builds — the starting point for an EDIT case. */
const GREETER_AGENT = `import { agent } from "@alexkroman1/aai";

export default agent({
  name: "Front Desk",
  greeting: "Front desk, how can I help?",
});
`;

/**
 * A tool for {@link GREETER_AGENT}, so `test_agent` has something to TRIAL.
 *
 * A file in `tools/` becomes a tool named for the file, so this is `greet` —
 * which is what makes `test_agent { tool: "greet" }` reach the harness's real
 * trial executor rather than stopping at the bundle load.
 */
const GREET_TOOL = `import { tool } from "@alexkroman1/aai";
import { z } from "zod";

export default tool({
  description: "Greet the caller by name",
  inputSchema: z.object({ name: z.string() }),
  execute: async ({ name }) => \`Hello, \${name}.\`,
});
`;

/**
 * A tool file with ONE deliberate type error: `orderId` is declared a number
 * and used as a string.
 *
 * Deliberately a type error and not a syntax error — the two take different
 * paths through the guest and this case is about the first. A file that does
 * not PARSE is refused before it is saved (the syntax gate, its own case
 * below); a file that parses and does not type-check is saved and the
 * diagnostic is appended to the write result, which is the loop under eval
 * here.
 */
const BROKEN_TOOL = `import { tool } from "@alexkroman1/aai";
import { z } from "zod";

export default tool({
  description: "Look up an order by its id",
  inputSchema: z.object({ orderId: z.number() }),
  execute: async ({ orderId }) => {
    return orderId.toUpperCase();
  },
});
`;

/** The pizza template, which twelve of the studio's own starter prompts name. */
const PIZZA_TEMPLATE = "pizza-ordering-agent";

/** An agent whose name disagrees with the spec beside it. */
const MISNAMED_AGENT = `import { agent } from "@alexkroman1/aai";

export default agent({
  name: "Pizza Palace",
});
`;

/**
 * A spec that FAILS against {@link MISNAMED_AGENT}, and is the workspace's own
 * statement of what the name should be.
 *
 * Both halves matter. The test is what makes `test_agent` report a failure, and
 * it is also the only place the right answer is written down — so a case can ask
 * for the tests to pass and then adjudicate WHICH side was changed, which is the
 * whole point: editing the assertion to match the code passes the tests and is
 * the failure mode worth catching.
 */
const NAME_SPEC = `import { expectDeployable } from "@alexkroman1/aai/testing";
import { expect, test } from "vitest";
import agentDef from "./agent.ts";

test("the desk is Bella Pizza", () => {
  expect(expectDeployable(agentDef).name).toBe("Bella Pizza");
});
`;

// ---- readers this file needs, and the vocabulary they lean on ---------------

/** The tools that CHANGE a script, i.e. the ones post-write diagnostics run for. */
const WRITE_TOOLS: ReadonlySet<string> = new Set(["write_file", "edit_file", "use_template"]);

/** The tools that LOOK before a change — the other half of an ordering claim. */
const READ_TOOLS: ReadonlySet<string> = new Set(["read_file", "list_files", "grep", "glob"]);

/**
 * The diagnostic the write tools append when the tree is red after a write.
 *
 * The pattern is over `formatPostWriteDiagnostics`' own opening, which is a
 * fixed string this package owns — the classification stays the CASE's, on the
 * same rule `aai-evals`' tool arms record: a tool result is a wire string whose
 * words that tool chose, so a harness shipping `writeWasRed()` would be
 * asserting on prose the guest may reword.
 */
const WRITE_WAS_RED = /Type errors after writing (\S+)/;

/** Did this call change a TypeScript file? (`.md` writes get no diagnostics.) */
function wroteScript(call: EvalToolCall): boolean {
  if (!WRITE_TOOLS.has(call.name)) return false;
  const rel = call.args.path;
  return typeof rel === "string" ? /\.tsx?$/.test(rel) : call.name === "use_template";
}

/**
 * Every red write was followed by another write to the SAME file.
 *
 * The repair loop, per occurrence rather than as a subsequence — the shape
 * `eachToolFollowedBy` exists for in `aai-evals`, spelled here because this
 * package may not import that one. Vacuous when no write came back red, which
 * is the correct reading: the case's ground-truth typecheck is what covers the
 * agent that simply wrote it right the first time.
 *
 * A THROW rather than an `expect`, and not only because `noMisplacedAssertion`
 * matches lexical position (it does — see "Testing this package"): it is the
 * rule the published readers already follow. The finding is a sentence naming
 * the file the agent was told about and abandoned, and a `toBe(true)` over a
 * boolean would lose it.
 */
function everyRedWriteWasRepaired(calls: readonly EvalToolCall[]): void {
  for (const [index, call] of calls.entries()) {
    const red = WRITE_WAS_RED.exec(call.result ?? "");
    if (red === null) continue;
    const rel = red[1];
    const repaired = calls
      .slice(index + 1)
      .some((later) => WRITE_TOOLS.has(later.name) && later.args.path === rel);
    if (!repaired) {
      throw new Error(
        `${call.name} on ${rel} came back with type errors and nothing wrote ${rel} again — ` +
          `the agent was told and moved on. Calls: [${toolNames(calls).join(", ")}]`,
      );
    }
  }
}

/**
 * GROUND TRUTH: the tree the agent left behind compiles.
 *
 * The one claim in this file a model cannot satisfy with prose, and the reason
 * every editing case ends with it. It carries the compiler's own output,
 * because "expected false to be true" is not a report of a type error.
 */
async function expectWorkspaceCompiles(ctx: Pick<StudioEvalContext, "typecheck">): Promise<void> {
  const typed = await ctx.typecheck();
  if (!typed.ok) throw new Error(`the workspace does not compile:\n${typed.output}`);
}

/** The index of the first call to any of `names`, or -1. */
function firstIndexOf(calls: readonly EvalToolCall[], names: ReadonlySet<string>): number {
  return calls.findIndex((call) => names.has(call.name));
}

// ---- the suite --------------------------------------------------------------

describeStudioEval((test) => {
  test(
    "adds what it was asked for and leaves the workspace type-clean",
    async ({ chat, ...ctx }) => {
      const turn = await chat.send(
        "Add a tool to this agent called check_balance. It takes an accountId string and " +
          "answers with that account's balance as a sentence — a fixed amount is fine, this " +
          "is a demo. Put it in the tools directory the SDK expects.",
      );

      // It acted rather than describing an edit it did not make — the failure
      // this agent's own base prompt names, and the one a coding agent's user
      // cannot detect from the reply alone.
      const wrote = turn.toolCalls.filter(wroteScript);
      expect(wrote.length, `no script was written: ${describeTurn(turn)}`).toBeGreaterThan(0);
      // The file is where the SDK looks for it. `tools/` IS the tool list for a
      // deployed agent, so a `check_balance.ts` anywhere else is a tool the
      // build will not enumerate — which is exactly the mistake a model that
      // knows other frameworks makes here.
      // …and it is NAMED for the tool, which is not a style point: "a file in
      // tools/ becomes a tool named for the file", so `checkBalance.ts` ships a
      // tool the model asked for under a name nothing will call.
      expect(
        await ctx.exists(path.join("tools", "check_balance.ts")),
        `wrote [${toolNames(wrote).join(", ")}] but there is no tools/check_balance.ts`,
      ).toBe(true);
      everyRedWriteWasRepaired(turn.toolCalls);
      await expectWorkspaceCompiles(ctx);
    },
    { files: { "agent.ts": GREETER_AGENT }, live: true },
  );

  test(
    "repairs the type error it is handed, and does not stop at the first diagnostic",
    async ({ chat, ...ctx }) => {
      const turn = await chat.send(
        "tools/lookup_order.ts does not compile. Fix it and make sure the workspace is clean.",
      );

      // The subject is the LOOP, so the two claims are the loop's two halves:
      // every red write was followed by another write to that file, and the
      // tree really is clean at the end. Neither is a claim about the reply.
      everyRedWriteWasRepaired(turn.toolCalls);
      await expectWorkspaceCompiles(ctx);
      // And it fixed the code rather than deleting the problem, which is the
      // cheapest way to make a compiler happy.
      expect(
        toolNames(turn.toolCalls),
        `deleted its way to a clean tree: ${describeTurn(turn)}`,
      ).not.toContain("delete_file");
      expect(await ctx.exists(path.join("tools", "lookup_order.ts"))).toBe(true);
    },
    {
      files: {
        "agent.ts": GREETER_AGENT,
        "tools/lookup_order.ts": BROKEN_TOOL,
      },
      live: true,
    },
  );

  test(
    "starts from a template by COPYING it, never by retyping it",
    async ({ chat, ...ctx }) => {
      const turns = await chat.sendAll([
        "I want the pizza ordering agent. Start this project from the template for it.",
      ]);
      const calls = toolCallsInTurns(turns);

      // The guest's own prompt says this — `toolchainPromptSection()`, appended
      // by `initStudioSession`: "the files arrive verbatim, so never retype
      // template code by hand". So this case grades shipped guest text rather
      // than the harness's prompt, which is what makes it worth having on this
      // side of the boundary at all.
      expect(
        toolNames(calls),
        `never reached for a template: ${turns.map(describeTurn).join(" | ")}`,
      ).toContain("use_template");
      // Byte-identical, which is the whole claim. A retyped agent.ts passes
      // every structural check the starter eval makes and is a different file.
      expect(await ctx.read("agent.ts")).toBe(await ctx.templateFile(PIZZA_TEMPLATE, "agent.ts"));
      // …and the way it must NOT have got there.
      const retyped = calls.filter(
        (call) => call.name === "write_file" && call.args.path === "agent.ts",
      );
      expect(
        retyped.length,
        "wrote agent.ts by hand as well as (or instead of) copying the template",
      ).toBe(0);
      await expectWorkspaceCompiles(ctx);
    },
    { files: {}, live: true, maxSteps: 20 },
  );

  test(
    "makes a failing spec pass by fixing the AGENT, not by editing the spec",
    async ({ chat, ...ctx }) => {
      const turns = await chat.sendAll(["The tests in this workspace fail. Get them passing."]);
      const calls = toolCallsInTurns(turns);

      // It ran them rather than reasoning about them — `test_agent` is the only
      // tool here that builds, loads and runs, so a turn that never calls it
      // has not checked anything it claims.
      expect(
        toolNames(calls),
        `never ran the tests: ${turns.map(describeTurn).join(" | ")}`,
      ).toContain("test_agent");
      // The spec is untouched, byte for byte. This is the case's subject: the
      // workspace states the right answer in exactly one place, and rewriting
      // the assertion to match the code makes the tests pass while destroying
      // the only record of what was wanted.
      expect(await ctx.read("agent.test.ts")).toBe(NAME_SPEC);
      // The agent took the name the spec asked for.
      expect(await ctx.read("agent.ts")).toContain("Bella Pizza");
      // GROUND TRUTH, run by the case rather than read off a tool result.
      const tests = await ctx.runTests();
      expect(tests.ran, "the workspace reported no tests to run").toBe(true);
      if (!tests.ran) return;
      expect(tests.passed, `the tests still fail:\n${tests.output}`).toBe(true);
    },
    {
      files: { "agent.ts": MISNAMED_AGENT, "agent.test.ts": NAME_SPEC },
      live: true,
      maxSteps: 20,
    },
  );

  test(
    "looks at a file before it changes it",
    async ({ chat, ...ctx }) => {
      const turn = await chat.send('Rename this agent to "Nightingale".');
      const calls = turn.toolCalls;

      // Forced by the tools rather than by instruction, which is what makes it
      // a fair claim: `edit_file` needs the exact existing text and `write_file`
      // needs the whole file, so an agent that changes this file without
      // reading it is guessing. An edit that MISSES is the observable failure
      // (the SDK's `coding-edit.ts` rewrite hint), and it costs a repair round.
      const read = firstIndexOf(calls, READ_TOOLS);
      const wrote = firstIndexOf(calls, WRITE_TOOLS);
      expect(wrote, `nothing was written: ${describeTurn(turn)}`).toBeGreaterThanOrEqual(0);
      expect(
        read >= 0 && read < wrote,
        `changed the file before looking at it — calls: [${toolNames(calls).join(", ")}]`,
      ).toBe(true);
      expect(await ctx.read("agent.ts")).toContain("Nightingale");
      await expectWorkspaceCompiles(ctx);
    },
    { files: { "agent.ts": GREETER_AGENT }, live: true },
  );

  // ---- the mechanisms a live model will not provoke -------------------------
  //
  // Each of these is a refusal, and a refusal can only be observed if something
  // CALLS the refused thing. A competent model does not write unparsable
  // TypeScript, address a path outside its workspace, or ask for a template
  // that does not exist — so each cost a red live run and got weakened before
  // `EvalCaseOptions.scripted` existed. What they grade is the guest's answer:
  // whether the sentence the tool sends back is one a model can act on.

  test(
    "refuses a file that does not parse, and says plainly that nothing was saved",
    async ({ chat, ...ctx }) => {
      const turn = await chat.send("Rewrite agent.ts.");
      const write = turn.toolCalls.find((call) => call.name === "write_file");
      const result = write?.result ?? "";

      expect(result, describeTurn(turn)).toMatch(/refused to write agent\.ts/);
      // The three things the sentence has to carry, because each answers a
      // move the model would otherwise make next: re-sending the same bytes,
      // testing a file it thinks it saved, and escaping the content twice.
      expect(result).toMatch(/NOTHING was saved/);
      expect(result).toMatch(/do NOT run test_agent first/);
      expect(result).toMatch(/over-escaping/);
      // And the file on disk is the one that was there.
      expect(await ctx.read("agent.ts")).toBe(GREETER_AGENT);
    },
    {
      files: { "agent.ts": GREETER_AGENT },
      scripted: true,
      stubReply: [
        {
          tool: "write_file",
          // Unbalanced braces: parses as nothing, which is the state the
          // syntax gate exists for — a file that does not parse cannot be
          // edited back into shape by text matching, so saving it would
          // strand the turn.
          args: { path: "agent.ts", content: 'export default agent({ name: "Front Desk",\n' },
        },
        "That file would not have parsed, so I have left it alone.",
      ],
    },
  );

  test(
    "refuses a path that leaves the workspace, and writes nothing outside it",
    async ({ chat, dir, ...ctx }) => {
      const turn = await chat.send("Write a note next to the workspace.");
      const write = turn.toolCalls.find((call) => call.name === "write_file");

      // `resolveInside` throws and the SDK's executor shapes the throw into a
      // result the model reads — which is the behaviour that matters here, and
      // the reason a spec must go through `runTool` rather than `execute`.
      expect(write?.result ?? "", describeTurn(turn)).toMatch(/Path escapes the workspace/);
      // The jail is a fact about the filesystem, so it is checked there.
      expect(await ctx.exists(path.join("..", "escaped.ts")), `${dir}/../escaped.ts exists`).toBe(
        false,
      );
    },
    {
      files: { "agent.ts": GREETER_AGENT },
      scripted: true,
      stubReply: [
        { tool: "write_file", args: { path: "../escaped.ts", content: "export const x = 1;\n" } },
        "I cannot write outside the workspace.",
      ],
    },
  );

  test(
    "answers an unknown template with the names that do exist",
    async ({ chat, ...ctx }) => {
      const turn = await chat.send("Use the pizza template.");
      const uses = turn.toolCalls.filter((call) => call.name === "use_template");

      expect(uses.length, describeTurn(turn)).toBe(2);
      // A refusal that does not list the alternatives makes the next call a
      // guess as well — this is the tool's own recovery path, and the reason
      // `copyTemplate` validates by membership in the real readdir listing
      // rather than by pattern.
      expect(uses[0]?.result ?? "").toMatch(/unknown template "pizza"/);
      expect(uses[0]?.result ?? "").toContain(PIZZA_TEMPLATE);
      // And the corrected call really copied it.
      expect(await ctx.read("agent.ts")).toBe(await ctx.templateFile(PIZZA_TEMPLATE, "agent.ts"));
    },
    {
      files: {},
      scripted: true,
      stubReply: [
        { tool: "use_template", args: { template: "pizza" } },
        { tool: "use_template", args: { template: PIZZA_TEMPLATE } },
        "Copied the pizza ordering template into the workspace.",
      ],
    },
  );

  test(
    "test_agent really builds, loads and trials the workspace it is pointed at",
    async ({ chat }) => {
      const turn = await chat.send("Build this agent, then try its greet tool.");
      const runs = turn.toolCalls.filter((call) => call.name === "test_agent");
      const built = runs[0]?.result ?? "";
      const trialled = runs.at(-1)?.result ?? "";

      // The build → load → report chain, in the order `test_agent` states it.
      expect(built, describeTurn(turn)).toContain("Bundle loaded in the sandbox");
      expect(built).toContain('Agent "Front Desk"');
      expect(built).toContain("pipeline mode");
      // The tool the BUILD discovered — `tools/greet.ts` is a tool by existing,
      // which is the one thing a bundle's config can say that its source
      // cannot be read for.
      expect(built).toMatch(/tools: greet/);
      // The workspace's own spec ran, and passed.
      expect(built).toMatch(/Tests: passed/);
      // And the trial really invoked it, in this sandbox, through the harness's
      // own executor. This case is the only thing that exercises
      // `studioBundleAccess` end to end THROUGH THE AGENT — the real in-guest
      // rolldown pass, the real bundle loader and the real trial executor —
      // which is where a break would otherwise surface as a starter eval
      // failure nobody could localize.
      expect(trialled, describeTurn(turn)).toContain("Hello, Ada.");
    },
    {
      files: {
        "agent.ts": GREETER_AGENT,
        "tools/greet.ts": GREET_TOOL,
        "agent.test.ts": `import { expectDeployable } from "@alexkroman1/aai/testing";
import { expect, test } from "vitest";
import agentDef from "./agent.ts";

test("is deployable", () => {
  expect(expectDeployable(agentDef).name).toBe("Front Desk");
});
`,
      },
      scripted: true,
      stubReply: [
        { tool: "test_agent" },
        { tool: "test_agent", args: { tool: "greet", args: { name: "Ada" } } },
        "It builds, its spec passes, and greet answers.",
      ],
    },
  );
});
