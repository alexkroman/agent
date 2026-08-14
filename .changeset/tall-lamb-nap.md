---
"@alexkroman1/aai-cli": minor
---

A file in `tools/` is now the tool. Tool files default-export their tool and are discovered at build time — `worker-bundler.ts` enumerates `tools/*.ts` and emits static imports, so a file that exists is a tool the model can call and there is no registration step to forget. Forgetting a `tools:` map line used to be silent: the file compiled, every check passed, and the tool never reached the model. The six shipped templates drop 62 map entries and their imports; `toolRegistry`/`withTools` (`@alexkroman1/aai/manifest`) own the name grammar, the default-export requirement, the flat-only rule and duplicate detection, each a build error naming the file. Retires the `template-tools` konsistent convention, which checked an export name nothing reads any more.
