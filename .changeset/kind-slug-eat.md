---
"@alexkroman1/aai-cli": patch
"aai-server": patch
"aai-studio-server": patch
---

Install pnpm with npm in the Modal service image instead of corepack. Node stopped shipping corepack in its official distributions at 25, so the 24 to 26 base-image bump broke every deploy at the first build step with 'corepack: not found' (exit status 127). aai init's dependency-install failure now points at npm install -g pnpm rather than a corepack command that does not exist on Node 25+.
