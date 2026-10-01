<!--
  GENERATED FILE — do not edit.

  Source: packages/aai-templates/scaffold/agent-guide/TESTING-EVALS.md
  Regenerate: node scripts/sync-agent-guide.mjs

  This copy ships inside the @alexkroman1/aai tarball so an agent working in
  a user's project reads guidance that MATCHES the installed SDK. It is the
  only copy such a project has: `aai init` writes a short pointer at
  AGENT_GUIDE.md as the project's CLAUDE.md rather than a snapshot that goes
  stale on the next `pnpm update`. See packages/aai/skills/aai/SKILL.md.
-->
# Testing and evals

Part of the aai authoring guide (start with the core guide). A TEST asserts
the agent's shape and its tools' logic (`pnpm test`); an EVAL drives a real
session and asserts what the agent did (`pnpm eval`). Testing a workflow BODY
— the replay engine, crashes, signals — is "Testing a workflow body" in
`WORKFLOWS.md`.

## Specs: `agent.test.ts`

Co-locate tests as `agent.test.ts` (the `custom-pipeline-agent` template is a
reference). **When the project has one, it is yours to maintain**: it asserts
the agent's shape — name, providers, tool names — so rewriting the agent
without updating it leaves a test asserting an agent that no longer exists.
When a test fails after your change, decide which side is stale: updating the
test to match the new agent is a normal fix, not a workaround. Do not delete a
test to make it pass.

**A spec that needs the agent as DEPLOYED imports one module:**

```ts
import agentDef from "virtual:aai/agent";
```

That is `agent.ts` with its `tools/` directory discovered and its
`system-prompt.md` applied — the same lowering `aai build` does, so a spec
measures the agent that ships rather than the raw default export (which has no
tools and the framework's default prompt). `vitest.config.ts` registers the
plugin that serves it; a scaffolded project already has it. For a runner that
is not vitest, `deployedAgent` on `@alexkroman1/aai/testing` is the same thing
written out.

**Call a tool with `runTool(tool, args, ctx)`** (`/testing`): passed the tool
itself, the result is typed by its `execute` — no `as` cast (the
`runTool(agent, "name", …)` form answers `unknown`). `expectDeployable(agentDef)`
runs the build's checks and returns a `DeployedConfig` (`name`,
`systemPrompt`, `mode`, `builtinTools`, …) to assert on.

The test doubles a tool body needs are on `@alexkroman1/aai/testing` too —
`createToolContext()` for a hand-built `ctx`, `stubDelegate` for a subagent,
`endSessionCalls(ctx)` for a hang-up, `stubStepFetch`/`stubSpeech`/
`stubUploads`/`stubPlaceCall` for step I/O — and each topic file names the one
its feature needs.

## Evals: `agent.eval.test.ts`

Run `pnpm eval` when you change what the agent DOES. Cases live in
`agent.eval.test.ts` (the `quickstart-agent` template ships one), and
EVERYTHING an eval needs — `describeEval`, the readers and claims,
`evalSimulation`, and stubs like `stubGatewayRoute` — is one import,
`@alexkroman1/aai-runtime/eval/vitest`:

```ts no-check
import { describeEval, expectCalled } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";
import agentDef from "./agent.ts";

describeEval(agentDef, (test) => {
  test(
    "looks the order up before answering",
    async ({ session }) => {
      // `say()` returns THAT turn — the reply, its tool calls, its events.
      const turn = await session.say("where is order W1234?");
      expectCalled(turn, "look_up");
      expect(turn.text).toMatch(/shipped/i);
    },
    // What a SCRIPTED model answers with when there is no key (below).
    { stubReply: "Order W1234 shipped yesterday." },
  );
});
```

Everything is real except the microphone and the speaker: your tools, your
prompt, the session's own event stream. Before trusting a green run:

- **With a provider key it uses a LIVE model** — it spends tokens, and it is a
  noisy instrument. One failure is a question, not a verdict; re-run before
  believing either answer.
- **Without one it uses a SCRIPTED model** answering each case's `stubReply`,
  and says so. That still proves the agent boots, the tools resolve and the
  session reaches a reply — it proves nothing about what the agent SAYS. Give a
  case `{ live: true }` instead when no script could honestly stand in (a tool
  the model has to choose for itself, a refusal, a judgement).

**Who is calling** is a suite or case option (a case's `null` clears it):
`clientId`, `phone` and `call` are what `sessionClientId`,
`sessionClientPhone`, `sessionCall` and `sessionContext` see; a refused call
reads as `session.refused`. A tool's `endSession(ctx)` really hangs up
(`turn.endedSession`, `session.ended`); that turn awaits `onSessionEnd`.
`network: evalNetwork({ state, routes })` answers every tool, builtin and step
`fetch`, refusing the rest: `ctx.network`. `workflows` takes a client or
per-case factory: `ctx.workflowClient`. A failure prints the conversation.

No eval can see anything below the audio boundary — when the agent decides you
stopped talking, barge-in, two sentences merging into one turn. Those need
`pnpm dev` and your own voice.
