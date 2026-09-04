---
"@alexkroman1/aai-cli": minor
---

`aai init` no longer publishes after scaffolding. Creating a project is now purely local: it scaffolds and installs, and shipping to production is the explicit `aai publish` step once `aai dev` says the agent works. The `--skip-deploy` and `--server` flags are gone with the behaviour, and the init result no longer carries `deployed`, `slug` or `url`.
