---
---

Remove the isolation-free `subprocess` sandbox backend; Apple containers are
now the local-dev path (production stays on Modal). Only private packages
(`aai-server`, `aai-guest`) change, so no release is needed.
