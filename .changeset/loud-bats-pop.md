---
"@alexkroman1/aai-ui": minor
---

Publish the four seams a custom chrome kept rebuilding.

`useSessionActions()` is `useSessionCore` narrowed to the eight control methods, with no snapshot subscription. `<Controls>` and `<StartScreen>` pair a one-field selector with the core; a template could not, so four components across three templates held a WHOLE-SNAPSHOT `useSession()` purely to reach `start`/`toggle` — and the snapshot object is rebuilt on every change, so those rows re-rendered on every STT partial. `Session` is now `SessionSnapshot & SessionActions`, so the member list is one list.

`useSessionStatus()` / `useSessionError()` are the only two snapshot fields more than one chrome ever selects, written inline eight times — including in `ConsoleShell`'s own `@example`, which taught the inline form. Their selectors are module scope, because `useSyncExternalStoreWithSelector` keys its selection memo on the selector.

`<SessionErrorBanner>` is the announced `role="alert"` banner without the frame around it, composed into `ConsoleShell` (which therefore no longer takes an `error` prop) so a full-bleed chrome can take the announced-error decision on its own. The three hand-rolled copies had already drifted, one of them dropping `error.code`.

`AGENT_STATE_LABELS` is the `Record<AgentState, string>` four pages spelled as a ternary chain, so a new state is a compile error rather than a silent fall-through to whichever word each chain ended on.

The three custom chromes that had each rebuilt these — `retail`, `dispatch-center` and `infocom-adventure` — now take them: no whole-snapshot `useSession()` left in any of the three, and `infocom-adventure`'s banner reports the error code it had dropped.
