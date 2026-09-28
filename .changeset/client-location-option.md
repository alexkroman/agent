---
"@alexkroman1/aai-ui": minor
---

`mountClient()` and `createBrowserSession()` take a `location` option — a string, or a getter asked on every connection attempt — sent as `?location=` on each connect (first, resume and reconnect, brokered or not), so a browser client can tell `open_meteo` and `google_places` where it is. A getter lets a UI change it without remounting; an empty answer sends nothing.
