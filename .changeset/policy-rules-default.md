---
"@alexkroman1/aai": patch
---

The default prompt's TOOLS section now carries the policy rules that two
published tau2-bench prompt studies converged on (Migliaa's airline prompt,
IBM ALTK-Evolve's retail playbook): check the policy against the fetched
records rather than the caller's claims or a tool's acceptance, do only what
was asked, treat a described choice as a search over every option, confirm the
whole request ONCE (opening "Nothing's changed yet.") and then make every write
that yes covered without asking again, and transfer a blocked request only after
the caller has heard and answered the obstacle. SPEAKING's two-sentence cap names
that one confirmation as its exception. Every agent with tools gets them; an
agent's own instructions still win on policy. Neither study ran on voice, and
this is not yet measured here.
