---
"@alexkroman1/aai-cli": major
---

`@alexkroman1/aai-cli/start`'s `StartOptions` is renamed `ProjectServerOptions`. It shared its name with `@alexkroman1/aai/workflow-api`'s `StartOptions` (`{ key, notify }` for starting a workflow run), an unrelated type, so an autocomplete list spanning both offered two `StartOptions` with nothing to tell them apart. `createProjectServer` and `executeStart` are unchanged apart from the parameter's type name.
