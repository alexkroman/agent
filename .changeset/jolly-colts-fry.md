---
---

Cut Supabase traffic through the platform: guests fetch their own worker bundle
from a signed Storage URL, studio event streams share one read per watched row,
and workspace metadata stamps patch the row instead of rewriting the file map.
Private packages only (aai-server, aai-guest, aai-studio-server).
