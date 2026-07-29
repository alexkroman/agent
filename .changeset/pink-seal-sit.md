---
"aai-server": patch
---

Add LLM-in-the-loop one-shot codegen evals for the studio coding agent (vitest-evals): a WorkerBuildJudge that requires generated workspaces to survive the production worker bundler, and a SandboxLoadJudge that loads the built worker in a real studio sandbox and validates the agent config. Run with pnpm --filter aai-server test:evals; skips without an LLM key.
