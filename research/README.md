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

This directory is empty on purpose — the convention and its gate land before the
first plan does, so the first author is not also the one inventing the shape.
This file is exempt from the frontmatter rule; it is the directory's own README,
not a plan.
