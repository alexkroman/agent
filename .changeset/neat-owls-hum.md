---
"aai-server": patch
---

Harden the platform against hostile tenants: a re-claimed slug no longer repeats
a deleted deploy's version (and so its guest bearer), owner secret/delete routes
re-check ownership under the slug lock, failed authentications on owner routes
are rate-limited per IP, a session token verified past its exp is no longer
cached forever, buffered guest responses are size-capped, the platform socket's
dispatch URL ignores a forged Host path, and session-state readEvents pages are
capped.
