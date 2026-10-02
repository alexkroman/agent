---
"@alexkroman1/aai": patch
"aai-server": patch
"aai-studio-server": patch
---

Give every module a co-located test and remove every vi.mock: collaborators the
specs used to mock by module are now optional injected seams that default to the
real implementation
