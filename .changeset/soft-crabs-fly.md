---
"@alexkroman1/aai-cli": minor
---

Warn at `aai build` and `aai deploy` about a COMPUTED workflow identity, and hold this repo's own shipped bodies to the same thing as `guard-invariants` rule 32.

`ctx.step`, `ctx.sleep` and `ctx.waitFor` all key a journal ROW by their first argument, and a body is replayed — so a computed identity mints a row no earlier walk reached, after which the engine either re-executes the step or refuses the run. On a one-line body a coin flip interpolated into a step name ran the side effect twice in 7 of 10 runs, with all 10 reporting `completed`.

The reason a check is needed at all is that the TYPE system provably misses this shape. All three methods constrain their identity with `Literal<Name>` (`string extends Name ? never : Name`), which refuses a name that has widened to `string` — and a template literal's type is a template-literal type rather than `string`, so ``ctx.step(`charge-${coin}`, charge)`` compiles cleanly. Verified against the real `WorkflowCtx`.

It stands at ZERO, in the repo and in every shipped template, and that is structural rather than lucky: identity is `(name, occurrence)` and the counter is per name, so a fan-out reuses one literal — `ctx.step("transcribeSegment", …)` inside the loop is the shipped seven-way one. A false-positive floor is a test: the scan runs over all fourteen templates and requires no findings, every template being a project somebody scaffolds and then builds. The template count is floored too, since a glob that stopped resolving is that assertion passing over nothing.

It WARNS rather than failing the build, same posture and same call site as `agentConfigWarnings`, because one shape is legitimate — a name interpolating a `const` string is the same on every walk. On `deploy` the findings join `warnings` rather than only being notified, so they reach studio Publish, which reads the result and never stdout.

Rule 30's other half — the scan for the non-deterministic READS themselves — is deliberately NOT ported to user projects, and the measurement is why: a faithful port reports exactly this repo's seven baselined occurrences and nothing else, and all seven are correct code (a read inside a step-called helper, the boundary `link-digest`'s own comment explains a line cannot see). A user's project has no baseline, so that port is a 100% false-positive rate on the only measurable corpus. Deciding the boundary needs a real parse, and a native parser cannot join a published CLI's runtime dependencies.

The pattern is duplicated between the two halves because neither can import the other — the gate script is plain node run over this repo, the CLI ships to users — so a test reads the gate's identity list out of its source and probes the CLI half with each name, making a divergence a failure.
