---
"aai-server": patch
---

Fall back to the broad us-east region for the web service: Modal rejects us-east-1 at deploy time ("Regions us-east-1 are not supported"), so the previous fallback list failed the deploy and shipped nothing.
