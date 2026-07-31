---
"@alexkroman1/aai-cli": major
---

Simplify the build pipeline: one Vite worker bundler for dev/deploy/studio (the Rolldown dev fast-path is gone), workers self-describe their config via a generated __aaiConfig wrapper entry and the platform extracts it in a guest sandbox at deploy time (the deploy body no longer carries agentConfig, and 'aai deploy' no longer evaluates agent code on the host), and raw-text imports now use Vite's native ?raw suffix — update 'import prompt from "./x.md"' to 'import prompt from "./x.md?raw"'.
