---
"aai-server": patch
---

Answer 503 when the platform database is unreachable, refuse Supabase's direct host as a pooler URL, and report a change stream that DROPS after joining. All three come from a production outage where a Modal secret pointed the admin pool at `db.<ref>.supabase.co`, which has no A record on a project without the IPv4 add-on: /studio/account answered an opaque 500 for 20+ minutes, the mode-only pooler guard could not see the wrong host, and the two agents-channel drops that evening were invisible to `health()` because one successful join marked a channel healthy forever.
