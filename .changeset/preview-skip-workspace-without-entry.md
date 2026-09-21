---
"aai-studio-server": patch
---

Skip the preview deploy for a workspace that has no `agent.ts` yet.

A new studio project's first edits are the coding agent scaffolding a tree, and the entry file is not the first thing it writes. Every one of those edits enqueued a preview deploy that could only ever come back with the CLI's "No agent.ts found in the current directory. Run `aai init` first." — which was then stamped as `previewError` and rendered in the Preview pane, telling a BROWSER user to run a CLI command. Production did it three times in five minutes on one project.

The deploy is now declined before it is attempted, which costs nothing that could have succeeded: `AGENT_ENTRY` is a constant, the worker entry imports `../agent.ts`, and both project kinds go through the same deploy — so a tree without it cannot build. `previewHash` is deliberately NOT stamped on that path, or the real deploy that runs once the file appears would read as already-deployed and never run.

Declining also clears a stale `previewError`, which is the half that is easy to miss: only a SUCCESSFUL deploy deletes that stamp, so any early return inherits a banner nothing else can ever clear. That clear is now shared with the already-deployed path rather than copied.
