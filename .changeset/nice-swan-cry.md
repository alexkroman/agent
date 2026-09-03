---
"aai-server": patch
"aai-studio-server": patch
---

Move every package's TypeScript under src/, and gate it.

Source now lives in packages/<pkg>/src/; manifests, tsconfigs, tool configs, guides, etc/ and static assets stay at the package root. rootDir/include are scoped to src/, so a repo artifact can no longer be emitted into dist/ by accident. The published dist layout and every exports target are unchanged — only the @dev/source condition names src/.

check:package-layout enforces it from both sides (no .ts outside src/, and every package has a non-empty src/), with corpus floors and a gate spec that A/Bs each half.
