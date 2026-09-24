---
summary: >-
  This package's capability contracts: the ten capabilities, what each
  promises, qualified ids, and the `.tsx` compatibility fixtures.
read_when: >-
  adding, removing or re-signing a public export of `.` or `/client-dir`, or
  when `pnpm check:api-contracts` names an `aai-ui:` capability.
---

# `src/contracts/` — the `aai-ui` capability contracts

The mechanism (epochs, `--update` / `--bump … --retain|--drop`, why an epoch owes
a frozen compiling example) is in `docs/CLAUDE.md`, "The authoring surface is
versioned in epochs". Only what is local to this package is here.

`entrypoints/` declares the capabilities; between them they must name every
`@public` export of `.` and `/client-dir`, or `pnpm check:api-contracts` fails.

| Capability | What it promises |
| --- | --- |
| `client` | the voice mount — `mountClient()`, its flat `ClientConfig`, the handle |
| `page` | the workflow-app mount — `mountPage()` (no session), plus `fetchClientConfig()`, the lookup a page must do for itself |
| `session` | `BrowserSession` (sealed), the snapshot, `useSession`, `useUserTranscript`, `useConversation` + `ConversationItem`, the errors |
| `push-to-talk` | `usePushToTalk` and `session.userTurn` (`UserTurnControls`) — separate so one agent mode's feature is not an epoch of every session |
| `hooks` | what a client reads off the AGENT: `useAgentState`, the two tool hooks, `useEvent` |
| `components` | the design system, `ConsoleShell` included, plus `useFlash`/`useCopy` (they render nothing and read nothing off the agent) |
| `forms` | `<Form>`, the field components, `<WorkflowFields>`, `fieldKindFor` (it names a FIELD) |
| `workflow` | `createWorkflowApi`, `useWorkflowRun`, `useWorkflowProgress`, `<WorkflowProgress>`, `<WorkflowPendingNote>`, `<WorkflowRunError>`, `useWorkflowSubmit`, `useWorkflows`, `useDownloadUrl`, `WORKFLOW_STATUS_LABELS`, `WorkflowRunStatus`. `WorkflowApi` is RE-EXPORTED from `@alexkroman1/aai/workflow-api`, so a client from either factory is one type |
| `theme` | `ClientTheme` + `useTheme`, and the five `--aai-*` CSS variables — a token is a name in somebody's CSS |
| `client-dir` | `defaultClientDir()`, the one export a SERVER calls |

- **Ids are qualified — `aai-ui:forms`, not `forms`.** `workflow` is a capability
  of both this package and the SDK, versioned independently; the CLI refuses a
  bare ambiguous name.
- **Compatibility fixtures here are `.tsx`** (`compatibility/<capability>/v<N>.tsx`)
  — a component library's frozen example is JSX or it is not evidence.
  `pnpm typecheck` compiles them, so a break names the epoch it broke. With no
  external consumers, superseded epochs are normally `--drop`ped.
- **Known fixture constraints:** `WorkflowApiOptions.token` cannot take an
  explicit `undefined` (`exactOptionalPropertyTypes`), and `api.get` is untyped
  on purpose — `useWorkflowRun<R>` is where a page names the shape.
- `internal-surface.json` is the `@internal` ratchet, per SUBPATH, and it stands
  at **zero** for the root barrel; the rule is in `../../CLAUDE.md`, "Public vs
  internal surface".
- **Read the report, not the name**, before making an export internal: a tuning
  constant no public signature names can go (`TRANSCRIBING_PLACEHOLDER`,
  `DEFAULT_*_POLL_MS`, `MAX_MISSING_READS` did), but `WebSocketConstructor` stays
  because `VoiceSessionOptions.WebSocket?` names it. A public doc comment that
  `{@link}`s a name you make internal fails `pnpm check:docs-md` — spell the
  value out instead.
