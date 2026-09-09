<!-- markdownlint-disable-next-line MD041 -->
The generated API reference for the published packages — every type, every
signature, every doc comment, rendered from the source.

**New here? Start with the [guide](/agent/) instead.** It is fifteen short
pages that build and ship an agent; this reference is what you reach for once
you know which name you are looking up.

- [Quickstart](/agent/start/quickstart/) — a working agent in five minutes
- [Tools](/agent/build/tools/) · [Session state](/agent/build/state/) ·
  [Voices and models](/agent/more/voices-and-models/)

## What's documented here

This is the API reference for what you write an agent AGAINST:

- **`@alexkroman1/aai`** — the SDK an `agent.ts` imports. Start with
  `agent()` and `tool()` on the root module, then the provider factory
  subpaths (`stt`, `llm`, `tts`, `s2s`) to swap pipeline stages, `tools`
  for the keyless network helpers callable from tool code, and `testing`
  for the fakes a spec hands a tool.
- **`@alexkroman1/aai-ui`** — the browser client for custom UIs:
  `mountClient()`, the session hooks (`useSession`, `useAgentState`,
  `useToolResult`, `useEvent`), and the framework-agnostic
  `createBrowserSession()`.
- **`@alexkroman1/aai-runtime/eval` and `/testing`** — measuring what an
  agent DID. `describeEval` and `openEvalSession` drive a real session from
  text and assert on the tools it called and what it said; `runWorkflow` and
  `runTextAgent` drive a durable workflow run and a text turn against the real
  engine. Both are written in the same vitest project as the agent.

Two published surfaces are deliberately absent. The rest of
`@alexkroman1/aai-runtime` — `createRuntime`, `createAgentServer`, the
transports and the provider openers — is aimed at somebody EMBEDDING an agent
rather than writing one, and has its
[README](https://github.com/alexkroman/agent/tree/main/packages/aai-runtime#readme)
plus committed API reports rather than a rendered page. And the `aai` CLI
(`@alexkroman1/aai-cli`) is documented in its
[README](https://github.com/alexkroman/agent/tree/main/packages/aai-cli#readme)
— its importable subpaths are internal build hooks, not a public API.

## Which one do I import?

**For a single name, read
[`API-INDEX.md`](https://github.com/alexkroman/agent/blob/main/API-INDEX.md)** —
every published symbol against the subpath to import it from, generated from
the same reports this reference is.

Three places on this surface publish more than one way to do a thing. Each
distinction is real; none is guessable from the names alone.

**A workflow client** — all three return a call set over the workflow HTTP API:

| Factory | From | For |
| --- | --- | --- |
| `createWorkflowApi()` | `@alexkroman1/aai-ui` | a page the agent serves — the base URL defaults to the page's own origin |
| `createWorkflowApiClient()` | `@alexkroman1/aai/workflow-api` | a caller with no page: a script, a cron job, a server |
| `createAgentClient()` | `@alexkroman1/aai/workflow-api` | the same, plus `/client-config` — one object for everything one agent answers |

**Testing** — five subpaths, split by what each one stands up:

| Subpath | Drives | Reach for it when |
| --- | --- | --- |
| `@alexkroman1/aai/testing` | nothing — it hands out fakes | calling one tool in isolation: `createToolContext`, `deployedAgent`, `runTool` |
| `@alexkroman1/aai/testing/vitest` | the same fakes, installed | you want `installStubGateway` to register its own cleanup |
| `@alexkroman1/aai-runtime/eval` | a real session, from text | asserting what the agent DID — which tools, in what order, and what it said |
| `@alexkroman1/aai-runtime/eval/vitest` | the same, as `describeEval` | writing those cases as vitest tests, run by `aai eval` |
| `@alexkroman1/aai-runtime/testing` | the real workflow engine / text agent | asserting a run slept, resumed, retried, or survived a dead worker |

**Reading a live session** — one hook returns everything and the rest are
slices of it, so a component re-renders on its own data rather than every
frame:

| Hook | Returns |
| --- | --- |
| `useSession()` | the whole snapshot, plus the actions |
| `useSessionStatus()` / `useSessionError()` | one field of the snapshot each |
| `useSessionActions()` | just the control methods — `start`, `toggle`, `reset`, `end`, … — which never change, so a button re-renders on nothing |
| `useSessionSelector(fn)` | whatever `fn` picks — the escape hatch for a slice with no hook |
| `useAgentState(projection)` | what the agent projects with `syncState`, typed by the projection |
| `useConversation()` / `useUserTranscript()` | what has been said |

## More

- [The guide](/agent/) — how to build and ship an agent
- [GitHub repository](https://github.com/alexkroman/agent)
- [Agent-building guide](https://github.com/alexkroman/agent/blob/main/packages/aai-templates/scaffold/CLAUDE.md)
  (ships inside the SDK as `node_modules/@alexkroman1/aai/AGENT_GUIDE.md`,
  which is where a scaffolded project's `CLAUDE.md` points)
