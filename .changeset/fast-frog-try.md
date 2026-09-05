---
"@alexkroman1/aai": minor
---

Publish `WorkflowInputOf` and `WorkflowRunOf` from the package root, and lead each module's reference page with what is in it.

Both were reachable only from `@alexkroman1/aai/workflow-api`, documented as the surface for a caller OUTSIDE the agent — while a `workflows/*.ts` body annotating its parameter and a `*_status` tool holding a run snapshot are exactly what the root barrel's membership test names. They stay on `/workflow-api` too, which still owns the capability. `WorkflowOutputOf` did not move: its reader really is a `client.tsx`.

The scaffold guide now carries the convention that makes them reachable at all: `workflow()` infers its output from `run`, so the obvious spelling is a `TS7022` circularity, and the way out is to name the input schema in a const and annotate the def.

Also: `@alexkroman1/aai-ui`'s root had no module doc, so its reference page opened on an alphabetically-first component; the module docs that led with why-this-exists now lead with what-is-here; and `API-INDEX.md` is a new generated reverse index of every published name against the subpath to import it from.
