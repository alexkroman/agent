---
summary: >-
  The workflow HTTP API's error-to-status classification and its upload-id
  boundary
read_when: >-
  editing `src/workflow/api/`, adding an error mapping, or touching an
  `/uploads/:id` route
---

# Workflow API

## Every environmental error is classified

`error-status.ts` maps a thrown value to a status, and
`error-classification.test.ts` requires no THIRD state: every environmental
code a Node service here can meet is either mapped or named in
`DELIBERATELY_INTERNAL` with a reason a 500 is right. A client cannot back off
on a 500 and a load balancer cannot shed on it.

- **Resource exhaustion** (`EMFILE`, `ENFILE`, `ENOBUFS`, `ENOMEM`) →
  `isResourceExhausted`, 503, ordered BEFORE the transport entry (it surfaces on
  socket operations).
- `UND_ERR_RESPONSE_STATUS_CODE` is internal: a response arrived, nothing
  transient to wait for.
- **Known gap, deliberately not guessed at**: `isCallerGone` reads a TOP-level
  `ECONNRESET`, so a wrapped reset (how `fetch` delivers it) is a 503 while a
  bare one is read as the caller hanging up (500). Whether anything OUTBOUND
  throws a bare top-level `ECONNRESET` (a `postgres` driver error might) is
  open; `syscall` is the candidate discriminator.

### A transport failure is a 503

`isTransportFailure` (`http.ts`) walks the `cause` chain (the code is rarely on
the thrown value) against a closed vocabulary and answers 503 with
`Retry-After: 1`.

- **`ENOTFOUND` is absent** — a hostname that does not resolve is a
  misconfiguration; `EAI_AGAIN` is in.
- **It is checked LAST of the 5xx entries** — a full disk (507) and an
  exhausted pool (503) surface transport-shaped codes and have better advice.
- **It is not `isCallerGone`**, which is checked first: an inbound socket that
  closed must not get a 503 written to it.

## An upload ID is checked at the ROUTER, for every `/uploads/:id` route

`uploadIdOr400` (`uploads.ts`) applies `UPLOAD_TOKEN_RE` (1–64 of
`[A-Za-z0-9_-]`) to all five routes, so a bad id is always a 400 and never
reaches the store (where `assertUploadToken` throws an unclassified `Error`).
A well-formed id nothing stored is still a 404 — "malformed" and "reclaimed" are
different answers. The upload store's own rules are in
[`../../CLAUDE.md`](../../CLAUDE.md).
