---
"@alexkroman1/aai": minor
---

Add linkConfirmationCode to the /utils subpath: the aai login confirmation code, previously derived identically in aai-cli and the studio client. Providers build their session shell through createSttSessionShell / createTtsSessionShell, so the per-stage cleanCloseIsFatal invariant lives in one place. aai deploy drops the inert --allow-missing-secrets flag; missing provider credentials always warn.
