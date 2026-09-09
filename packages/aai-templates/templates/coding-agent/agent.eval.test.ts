// An EVAL: does the agent actually behave? Run it with `aai eval`.
//
// A test asserts about the config and the tools (see agent.test.ts — it never
// calls a model). An eval drives the real thing: a real `createTextAgent`, the
// real tool executor, the real event stream, over a real directory on disk.
//
// `describeTextEval` is `describeEval`'s text-mode sibling — the same two modes
// and the same announce line, over `openEvalTextAgent` rather than a session,
// because `createRuntime` refuses a text agent by name:
//
//   * with a provider key — a LIVE model. This spends tokens, takes a few
//     seconds a case, and is a NOISY instrument: one failure is a question, not
//     a verdict.
//   * without one — a SCRIPTED model answering each case's `stubReply`. The
//     agent, its tools and this file all really run, and the files really
//     change, so what it proves is that the wiring works. It proves nothing
//     about what the model CHOSE.
//
// The claims below are all about tool CHOICE — did it look before it edited,
// did it edit rather than rewrite — because that is what a coding agent's
// system prompt is for and the only thing a transcript cannot show you.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import agentDef from "virtual:aai/agent";
import { toolNames } from "@alexkroman1/aai-runtime/eval";
import { describeTextEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { beforeEach, expect, vi } from "vitest";

const workspace = vi.hoisted(() => {
  // Hoisted above the imports, because `shared.ts` reads this once at module
  // scope — see the same note in `agent.test.ts`.
  const root = process.env.TMPDIR ?? process.env.TMP ?? "/tmp";
  const dir = `${root}/coding-agent-eval-${process.pid}`;
  process.env.WORKSPACE_DIR = dir;
  return dir;
});

/** The tiny project each case gets a fresh copy of. */
beforeEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    path.join(workspace, "cart.ts"),
    "export function total(prices: number[]): number {\n" +
      "  return prices.reduce((sum, price) => sum + price, 0);\n" +
      "}\n",
    "utf-8",
  );
  writeFileSync(path.join(workspace, "README.md"), "# Shop\n\nA very small shop.\n", "utf-8");
});

const read = (rel: string): string => readFileSync(path.join(workspace, rel), "utf-8");

describeTextEval(agentDef, (test) => {
  test(
    "answers a question about the code by READING it, and changes nothing",
    async ({ agent }) => {
      const turn = await agent.send("what does total() in cart.ts do?");

      // The finding this case exists for: an agent that answers from the name
      // alone sounds exactly like one that read the file.
      expect(toolNames(turn.toolCalls)).toContain("read_file");
      expect(turn.text).toMatch(/sum|add|total/i);
      // A question is not a change. Any write here is a real finding.
      expect(toolNames(turn.toolCalls)).not.toContain("write_file");
      expect(toolNames(turn.toolCalls)).not.toContain("edit_file");
      expect(read("cart.ts")).toContain("reduce");
    },
    {
      stubReply: [
        { tool: "read_file", args: { path: "cart.ts" } },
        "It sums an array of prices and returns the total.",
      ],
    },
  );

  test(
    "edits the file rather than rewriting it, and the change lands on disk",
    async ({ agent }) => {
      const turn = await agent.send("rename the `sum` parameter in cart.ts to `running`");

      expect(toolNames(turn.toolCalls)).toContain("edit_file");
      // `write_file` would also produce a correct file, and it is the shape
      // that silently drops the code a model forgot to repeat — which is the
      // whole reason the prompt names `edit_file` as the primary tool.
      expect(toolNames(turn.toolCalls)).not.toContain("write_file");
      expect(read("cart.ts")).toContain("running");
      expect(read("cart.ts")).not.toContain("sum");
    },
    {
      stubReply: [
        { tool: "read_file", args: { path: "cart.ts" } },
        {
          tool: "edit_file",
          args: {
            path: "cart.ts",
            oldText: "(sum, price) => sum + price",
            newText: "(running, price) => running + price",
            replaceAll: false,
          },
        },
        "Renamed it.",
      ],
    },
  );

  test(
    "finds a symbol with a SEARCH rather than by reading the tree",
    async ({ agent }) => {
      const turn = await agent.send("where is total defined?");

      // Either search tool is a right answer; reading every file is not, and
      // on a real repository it is the difference between one call and fifty.
      expect(toolNames(turn.toolCalls).some((name) => name === "grep" || name === "glob")).toBe(
        true,
      );
      expect(turn.text).toContain("cart.ts");
    },
    {
      // A live model may reach for either; the script picks one so the case
      // still runs, and the assertion above stays true of both.
      stubReply: [{ tool: "grep", args: { pattern: "function total" } }, "In cart.ts, line 1."],
    },
  );

  test(
    "runs a command when asked, instead of describing one",
    async ({ agent }) => {
      const turn = await agent.send("how many lines does cart.ts have? use the shell");

      expect(toolNames(turn.toolCalls)).toContain("bash");
      expect(turn.text).toMatch(/3/);
    },
    { stubReply: [{ tool: "bash", args: { command: "wc -l < cart.ts" } }, "3 lines."] },
  );
});
