---
"@alexkroman1/aai": patch
---

Declare MIT license terms in the published packages: every tarball shipped with no license field and no LICENSE file of its own, which registries and license scanners read as all-rights-reserved. Also declare sideEffects - false for aai and aai-runtime, and the css entries for aai-ui, whose styles.css consumers import for effect.
