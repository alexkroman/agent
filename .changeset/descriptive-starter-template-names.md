---
"@alexkroman1/aai-cli": patch
"aai-studio-server": patch
---

Rename every starter template so its name says what it is, and give the catalog one description shape.

The 28 template directories now carry a suffix naming their KIND — a voice agent ends `-agent`, a workflow app ends `-workflow` — so `aai init`'s picker, `aai templates` and the studio's `list_templates` all say which front door a starter has before you read a line of it. That was the inconsistency worth fixing rather than the verbosity: `recap-workflow` and `research-workflow` were voice agents whose names claimed otherwise, while four of the six real workflow apps (`link-digest`, `spoken-summary`, `call-audit`, `redline`) claimed nothing. Six more said nothing about their subject at all — `simple`, `pipeline-simple`, `retail`, `redline`, `night-owl`, `solo-rpg`.

| was | is | was | is |
| --- | --- | --- | --- |
| `simple` | `quickstart-agent` | `plan-and-execute` | `research-planner-agent` |
| `pipeline-simple` | `custom-pipeline-agent` | `briefing-desk` | `topic-briefing-agent` |
| `web-researcher` | `web-research-agent` | `hiring-desk` | `applicant-screening-agent` |
| `code-interpreter` | `code-interpreter-agent` | `hotel-desk` | `hotel-reception-agent` |
| `health-assistant` | `medication-safety-agent` | `word-wrangler` | `word-game-agent` |
| `night-owl` | `entertainment-picks-agent` | `research-workflow` | `research-handoff-agent` |
| `pizza-ordering` | `pizza-ordering-agent` | `recap-workflow` | `meeting-recap-agent` |
| `infocom-adventure` | `text-adventure-agent` | `link-digest` | `link-digest-workflow` |
| `solo-rpg` | `tabletop-rpg-agent` | `spoken-summary` | `spoken-summary-workflow` |
| `dispatch-center` | `emergency-dispatch-agent` | `call-audit` | `call-audit-workflow` |
| `retail` | `retail-orders-agent` | `redline` | `document-redline-workflow` |
| `travel-concierge` | `travel-concierge-agent` | `podcast-digest` | `podcast-digest-workflow` |
| `executive-assistant` | `executive-inbox-agent` | | |
| `roadside-assist` | `roadside-assistance-agent` | | |
| `support-line` | `technical-support-agent` | | |

`transcription-workflow` already fit and did not move. `aai init`'s default template is `quickstart-agent`, and the studio's nine agent starters and six workflow starters name the new directories — a starter whose prompt named a template that no longer exists would have had the coding agent write one from prose instead of copying the files.

The descriptions moved with the names. Every catalog entry in `packages/aai-templates/README.md` now reads the same way — what the agent IS, then the one SDK primitive it is the worked example for — and the studio's starter chips are all "A ⟨role⟩ that ⟨does what⟩" rather than a mix of roles, mechanisms and template names. Two display names were stale or wrong for a caller to hear: `pipeline-simple`'s agent introduced itself by its own directory name, and `simple`'s was "Simple Assistant".

What deliberately did NOT change: the persona names a caller actually hears (Scout, Coda, Dr. Sage, Pizza Palace), the `redline` workflow name inside `document-redline-workflow`, the `retail` session-slot key, and every attribution — `research-planner-agent` still cites LangGraph's `plan-and-execute` tutorial by that name, because the pattern is theirs and the template name is ours.
