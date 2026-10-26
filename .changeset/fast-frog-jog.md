---
"@alexkroman1/aai-ui": patch
---

ThemeProvider restores the page from one shared snapshot when the last live
provider unmounts, so two clients disposed in mount order no longer leave the
first one's theme tokens on :root.
