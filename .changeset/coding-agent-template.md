---
"@alexkroman1/aai": minor
"@alexkroman1/aai-runtime": minor
"aai-guest": patch
"aai-server": patch
"aai-templates": patch
---

Extract the studio coding agent's tool set into the SDK, and ship a generic coding agent as a template.

## The nine tools are `@alexkroman1/aai/coding-tools` now

`createCodingTools({ dir })` answers the tools an agent that edits code turns out to need — `read_file`, `write_file`, `edit_file`, `delete_file`, `list_files`, `glob`, `grep`, `bash`, `todo_write` — keyed by the names the model calls, over ONE directory and reaching nothing outside it. Every one of them was already written, tested and tuned; what it could not be was USED, because it lived in `aai-guest`, a private package, closed over one studio session's workspace and tangled with the three things only the studio wants: a write-time syntax gate, a post-write type check, and a bundle trial.

What survives deleting all of that is most of it. `studio-edit.ts` and `studio-grep.ts` moved as `host/coding-edit.ts` and `host/coding-grep.ts` with their specs, the capped child-process runner moved as `host/coding-spawn.ts`, and `resolveInside`/`writeFileWithParents`/`isPathInside` joined `host/workspace-files.ts` — the module that already owns what a workspace IS on disk, and where the containment test now has ONE implementation rather than the four it had (`aai-runtime`'s `server-static.ts` re-exports it; the copies that were only correct for an absolute, normalized, trailing-slash-free root are gone).

Three seams a host fills in, and each is a rule the studio paid for:

- **`validate` refuses a write BEFORE it lands.** The studio parses the file: one that does not parse cannot be edited back into shape by text matching, so writing it strands the turn — sixteen steps of read → edit → "could not find that text", no work produced.
- **`afterWrite` appends to a write that SUCCEEDED**, which is where the studio hands back the workspace's type errors inside the result of the write that caused them. It is the cheap half of what a language server would do and the place a repair round is actually saved.
- **`env` is `bash`'s child environment**, defaulting to this process's own — right for a CLI on a laptop, wrong for a sandbox, which passes an allow-list so a credential the host holds is out by construction rather than by remembering to subtract it. The studio still passes its 24-name `workspaceChildEnv()`.

`CODING_TOOL_DESCRIPTIONS` and the four limits ride along on the same subpath, because a host that overrides a description has to quote the number the code enforces, and cannot keep the two in step with a constant it may not import. The machinery UNDER the tools is not published with them: the edit matcher and the workspace grep have no consumer outside `coding-tools.ts`, and only the capped child-process runner is on `@alexkroman1/aai/host-internal` — because the guest harness spawns npm, the CLI bundler and the workspace test run through it, and each decides for itself whether a killed child is a failure or an annotated line. A name published in anticipation of a consumer is a surface with no reader.

The record is typed by NAME (`Record<CodingToolName, ToolDef>`, narrowed by `only`) rather than by an index signature, because a template's `tools/read_file.ts` default-exports one entry of it and under `noUncheckedIndexedAccess` an index signature hands back `ToolDef | undefined`.

It costs `@alexkroman1/aai` two runtime dependencies, `diff` and `picomatch`, which were `aai-guest`'s. Both are small and pure-JS; the artifact-size budget will report them and this is the intent.

## `templates/coding-agent`

A generic coding agent: `text: true`, the nine tools over `WORKSPACE_DIR`, a `system-prompt.md` that is most of what makes it good, and nothing about building voice agents with this SDK. It is the first TEXT-mode template, and this repo's guide previously argued there could not be one — the argument was right about DEPLOYMENT (`createRuntime` refuses `text: true` by name, so there is no session for `aai dev` or the platform to serve) and wrong about the template, since a starter is a worked example first. So it ships its own front door: `chat.ts`, which is `createTextAgent` plus `withToolsDir` (a tool is a FILE even with no bundler in the path), a `readline` loop, and the conversation as a message list the file keeps.

Its tools are ONE `createCodingTools` call in `shared.ts` that each `tools/*.ts` re-exports an entry of — nine factory calls would be nine chances to point one at a different directory, and the directory is the only security-relevant decision in the template. The template says so where an author will read it: `bash` runs what the model wrote with the authority of the process, which is the authority the write and delete tools already have, so it grants nothing new — what it does is make the grant obvious.

## A TEXT agent's eval suite: `describeTextEval`

`@alexkroman1/aai-runtime/eval/vitest` gains `describeTextEval`, and `/eval` gains `evalTextCredentials`. A template's eval must import that vitest subpath (konsistent's `template-eval-spec`), and what was there for a text agent was a voice suite that refuses one: `describeEval` opens `openEvalSession` → `createRuntime`. Everything a case author sees is shared — the two modes, the announce line, the per-case `stubReply`, the `live`/`scripted` markers, the `EvalTurn` and every reader above it — including `modeFrom`, so `AAI_EVAL_STUB` and `AAI_REQUIRE_EVAL` cannot come to mean one thing at two doors of three and another at the third.

`evalTextCredentials` is a second gate rather than a flag on the first, because `evalCredentials` OVER-ASKS here: it answers about a voice agent, so an agent with no complete pipeline gets the default AssemblyAI STT key added, and a text agent declaring `anthropicLlm()` was reported as needing a key it will never read — which skips a suite the machine could have run live. It asks about the LLM alone, and about the DEFAULTED descriptor when the agent declares none, so the question is asked about the model the run would use.

That is an additive change to the `aai-runtime:eval` capability: epoch 3, with epoch 2 RETAINED and its frozen authoring example written — `v2.ts` is `v1.ts` plus the two names epoch 2 added, used where a case would really reach for them.

## Why a carrier is in the header

`aai-server` takes a patch because this changes `aai-guest`, whose built `dist/harness.mjs` is baked into the guest snapshot image the platform spawns every sandbox from — so the change reaches production through a server deploy and nothing else. Nothing in `aai-server` itself is touched.

## What changed in the studio, and what did not

`createStudioTools` is `createCodingTools` with the three seams filled plus `test_agent`, which stays whole — it is the one tool that knows the workspace is an aai agent. The descriptions split the same way: the SDK's, three studio OVERRIDES (a write is type-checked, dependencies have their own tools, a workspace syncs back), and the tools only this host has. `studio/tool-descriptions.test.ts` asserts the three maps together cover the agent's real tool set exactly and that an override names a tool the SDK actually describes — an override of nothing is prose the model never reads. `studio/tools.test.ts` gave up the cases that are now the SDK's and keeps the ones about the seams. No behaviour changed in the studio.
