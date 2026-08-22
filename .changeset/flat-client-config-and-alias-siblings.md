---
"@alexkroman1/aai-ui": major
---

Say the duplicated types once, and stop the config union refusing what
`client()` can render.

`WorkflowStreamSubmission<R>` was `WorkflowSubmission<R>` character for
character — eight fields, identical types, differing only in prose — and
`UseWorkflowStreamOptions` restated `Omit<UseWorkflowSubmitOptions, "wait">` the
same way. Both are aliases now. The property the copies existed to describe is
that the two hooks are drop-in siblings, and a copy is exactly the thing that
cannot hold it: `contracts/compatibility/workflow/v9.tsx` asserted the result
half by hand ("if these two return types ever diverge, this function stops
compiling — which is the assertion"), which is a test that the copying was done
correctly rather than a reason not to copy. The stream-specific prose moved onto
the aliases, and epoch 13's example adds the options half, which the copy could
never guarantee.

`ClientConfig` is one flat type instead of a union of `ConfigTier` and
`ComponentTier` over a shared `BaseOptions`, and the three are no longer
exported. The union existed only to express "`component` and `sidebar` are
mutually exclusive", spelled with `?: never` — and that shape had already
backfired twice, both recorded in `define-client.tsx`: `client({ name,
component })` and `client({ component, tools })` are the natural things to
write, both were refused with *"Type 'string' is not assignable to type
'undefined'"*, and both bans were lifted after costing build rounds. What was
left banned was `sidebar` beside a `component`, inviting the identical failure
for a combination `client()` can simply render — so it renders it, wrapping the
custom component in the same `SidebarLayout` the default shell uses. `sidebar`
beside a `component` was silently dropped before; now it is a pane.

`VOICE_CAPTURE_CONSTRAINTS` moves to `@alexkroman1/aai-ui/internal`. It is a
framework decision with no `client()` field to set — the same category as the
audio budgets `types.ts` already re-exports from the SDK's own `/internal` —
and no `client.tsx` in the tree ever named it. A chrome that bypasses
`client()` and opens its own microphone reaches it there, beside the providers
it also needs.

`aai-ui:session` also gained the guard it was missing. The capability froze
`useUserTranscript` and the headless `createSessionCore` path, which has no
real consumers, and left out `useSession` — the third-most-used session export
across the templates. Epoch 4's example renders from it: the snapshot, the
controls, and `AgentState` in the `satisfies Record<AgentState, string>` idiom
three templates use.
