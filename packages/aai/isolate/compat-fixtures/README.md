# Protocol Compatibility Fixtures

Pinned JSON snapshots of valid wire-format messages. Unlike inline snapshot
tests, these files **never auto-update** — they represent what
already-deployed clients and agents actually send and receive.

## When to create a new version

Create a new `v{N}.json` when you intentionally change the protocol and
have confirmed all deployed clients/agents have been updated. The old
fixture stays to protect any stragglers.

## Rules

- **Never modify** an existing fixture file after it's committed.
- **Never delete** a fixture unless you're certain no deployed code depends
  on that version.
- One example per variant, plus examples with/without optional fields.

## What's covered

- `ServerMessage` — all server-to-client WebSocket JSON messages
- `ClientMessage` — all client-to-server WebSocket JSON messages
- `KvRequest` — KV operations (also used by the sidecar since it shares
  the same schema)
- `constants` — wire-format constants (audio format, sample rates, error codes)
