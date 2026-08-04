---
"aai-server": patch
"aai-guest": patch
---

Two more guest-ownership moves: replica shutdown RETIRES agent guests
(one awaited deadline-carrying drain each — live calls finish in the guests
after the replica exits) instead of count-poll-terminate, deleting the whole
shutdown session-drain machinery; and the client-config broker now PROXIES
name/greeting from the guest's own `/client-config` (the bundle's live agent
definition), making the stored config fully opaque to the host — no
field-level reader remains.
