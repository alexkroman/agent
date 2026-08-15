# research/

Issue-backed implementation plans for proposed changes.

A document here is a **plan attached to tracked work**, not an idea parked
somewhere. `guard-invariants.mjs` rule 10 requires frontmatter with a non-empty
`issue` and `status` plus an ISO `last_updated`, so a plan can always be traced
to the issue that owns it and told apart from a stale one:

```markdown
---
issue: https://github.com/alexkroman/agent/issues/123
status: proposed
last_updated: "2026-08-12"
---

# Title
```

`status` is free text; `proposed`, `accepted`, `implemented` and `abandoned` are
the ones in use. An abandoned plan stays, with its status set — the reasoning is
usually why the next proposal is different.

## Why this exists

Rationale in this repo has one home today: `AGENTS.md` and the per-package
`CLAUDE.md` files. That works for a rule someone must follow and works badly for
a change someone is *considering* — a design that lands, changes shape twice and
then gets abandoned leaves three paragraphs in a guide that describes code
nobody wrote. It is also the direct cause of the size problem those guides now
have a gate for: the root guide reached 233,000 characters one well-justified
paragraph at a time, and `check:claude-md` caps every guide at 120,000 because
past ~150,000 an agent silently reads half of one.

So the split is by AUDIENCE, not by length:

- **A guide** says what to do in code that exists. It is loaded into an agent's
  context on every task, so everything in it competes for that budget.
- **A research doc** argues for a change to code that does not exist yet. Nobody
  needs it loaded to work on something else.

When a plan here ships, the rule it establishes moves into the owning package's
guide as a few lines, and the doc keeps the argument. See "Updating AGENTS.md".

## A numeric prefix orders plans that depend on each other

`1-`, `2-`, `3-` … means "do these in this order", and the prefix is only worth
adding when the order is a REAL constraint rather than a preference — one plan
builds a mechanism the next one consumes. `3-session-event-stream.md` needs the
per-session store `2-durable-session-state.md` builds, so the numbers record a
dependency a reader would otherwise have to reconstruct from three documents.

Two things the prefix does not mean. It is not a priority queue — two adjacent
numbers may be independent and parallelizable, and each doc says so in its own
text. And it is not a promise about scheduling: an unnumbered plan is not
lower-priority, it is one whose ordering nothing else depends on.

A plan whose dependency is dropped keeps its number; renumbering the directory
every time one lands would invalidate every reference to it, and the numbers are
cheap enough to leave with gaps.

## A plan here does not design for backwards compatibility

Nothing published is depended on yet, so a plan proposes the shape the API should
have and breaks whatever it has to. No deprecation shims, no dual paths, no
"keep the old one working until we trust the new one" — that last is how a
replacement ends up never being trusted, and it leaves two mechanisms doing one
job with the old one still carrying the traffic.

Two mechanical consequences worth stating, because both look like compatibility
work and are not. An epoch bump for a change like this is
`--bump <capability> --drop "<reason>"`, never `--retain`: the contract mechanism
exists to CLASSIFY a break, and a retained epoch owes a frozen example that still
compiles, which is a promise these plans are not making. And a changeset for one
is `major`.

## What a plan owes the gates, once, so six documents need not repeat it

Three of these bite on nearly every plan here, and none is visible in a diff:

- **A new public export must JOIN a capability.** `check:api-contracts` asserts
  the capability naming is exhaustive over the authoring subpaths, so an export
  belonging to none fails until somebody decides which contract it is in — the
  same decision as "who is promised this". Deleting exports is free; adding one
  is a decision the gate collects.
- **A ratchet a plan LOWERS should be lowered in the same change.**
  `escape-hatch-baseline.json` and `guard-invariants-baseline.json` both warn when
  a run comes in under budget, naming the entries to give back, because unclaimed
  headroom is a hatch the next branch gets for free. A plan deleting a cast or
  retires a rule owes the `--update`.
- **A new ratchet goes in `guard-invariants-rules.mjs`, at the next free number.**
  IDs are stable, so a retired rule does not free its number and 1-13 are in use
  today. As a rule it costs no new script, no new baseline file, no CI wiring and
  no new gate-under-the-gate spec — all four already exist there. As a fourth
  baseline file it costs all of them.

This file is exempt from the frontmatter rule; it is the directory's own README,
not a plan.
