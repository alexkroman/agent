---
"@alexkroman1/aai-cli": minor
---

The CLI and the studio are now one workflow: new `aai list`, `aai pull`, `aai push`, and `aai publish` commands round-trip a project's source through its studio workspace (fast-forward-checked pushes, scaffold-completed pulls), `aai delete` deletes the studio project with a server-side cascade to its deployed agents, and the user-facing `aai deploy` command is gone — production deploys run exclusively through the studio's Publish path (the hidden `deploy` subcommand remains as the internal mechanism the project sandbox executes). `.env` values now sync as agent secrets during `aai publish`.
