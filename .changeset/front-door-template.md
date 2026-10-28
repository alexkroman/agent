---
"@alexkroman1/aai-cli": patch
---

Templates: a new `front-door-agent` template — a smart door and the owner's
phone on one page. A phone links by a spoken code (`mintDigitCode`, `hashCode`,
`createLinkedClient`, `useRouteMutation`), visitors' messages and a signed
hardware ring (`webhookRoute`) reach it through `stepNotifyClient`, it watches
the door live with `useInbox` + `inboxEventToItem`, and a daily digest reads the
door's log with `stepClientTranscript`.
