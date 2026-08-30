---
"@alexkroman1/aai": patch
---

Four runtime error messages told you to import `withDiscoveredTools` from `@alexkroman1/aai/testing`, which does not export it. They now name what a spec actually uses: `virtual:aai/agent` under vitest, or `deployedAgent` under any other runner.
