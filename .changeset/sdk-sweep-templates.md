---
"aai-templates": minor
"@alexkroman1/aai-cli": patch
---

Re-express every template through the SDK surface it had been hand-rolling.

The templates are the SDK's reference consumers, so a primitive with no worked
example is one nobody is shown — and the sweep's finding is that those are
exactly the primitives templates got wrong by hand. `createKeyedLock` had no
exerciser at all, and both templates needing mutual exclusion had written
something broken: `roadside-assist` handed every concurrent caller the same
truck (nothing marked one taken), and `hiring-desk` lost updates on the counter
bounding its own feedback loop, silently unbounding `MAX_FEEDBACK_ROUNDS`. Both
now go through the primitive, and both bugs are pinned by tests that fail
against a passthrough lock.

Around twenty defects came out with them. A shipped `"1 episode summaries"`
whose spec pinned the typo (`plural`); float drift in two carts, one rate with
cents making it visible (`roundMoney`); a grader's `reason` read by nobody
(`GuardrailVerdict`); a clamped upload read that produced a transcript missing
its tail and reported it complete; `solo-rpg` and `dispatch-center` each
declaring a dialog, gating tools with it, and never passing it to `agent()`, so
per-state instructions reached the model only on turns that happened to run a
gated tool; a weekday named by `toLocaleDateString`, which answers to the host's
ICU build rather than the guest's; a reservation lookup that normalized one side
of its comparison and so never matched a spoken code; and four tools declared as
a plain `tool()` over `slot.get(ctx)`, which the package guide describes as a
compile error and is not.

`web-researcher` gains the first `mcpServers` example in the repository, gated
on an env var so the starter still deploys with no credential. `pipeline-simple`
becomes the worked example for the provider surface — the option types, model
and voice constants, and both presets — which had none.

The CLI is named alongside it for the reason every template changeset names it:
`bundle-templates.mjs` copies `templates/` into the CLI's dist at build time, so
a changeset naming `aai-templates` alone bumps a version nobody resolves.
