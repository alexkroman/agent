---
"@alexkroman1/aai": patch
---

Close four silent-failure gaps at build time: a tools/ file that shadows an enabled builtin is now a named build error, an inverted minTurnSilenceMs/maxTurnSilenceMs window is refused where the pair resolves, a Cartesia or Rime voice the SDK cannot check is reported as unvalidated with its failure mode, and `aai build` reports WHICH system prompt shipped (the file, agent.ts, or the framework default).
