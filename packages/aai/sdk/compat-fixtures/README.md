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

- `SessionEvent` — all server-to-client WebSocket JSON messages
- `SessionCommand` — all client-to-server WebSocket JSON messages
- `constants` — wire-format constants (audio format, sample rates, error codes)

`KvRequest` was covered until KV support was removed from the SDK (a
deliberate breaking change — the guest RPC no longer has KV operations).

## v1 was retired, and it is the worked example of the rule above

`v1.json` described the protocol before the session event stream: `config` and
`audio_done` declared outside the event vocabulary, event names in a mix of
tenses (`reply_done`, `speech_started`, bare nouns like `agent_state`), commands
sharing one union with events, no `meta` envelope, and a `history` frame the
client used to push its own conversation back in.

Every one of those changed at once, so **no deployed code speaks v1** — nothing
published is depended on yet — and "never delete a fixture unless you're certain
no deployed code depends on
that version" is satisfied rather than bent. Keeping it would have meant a suite
asserting that the current schemas still accept a vocabulary they deliberately
do not, i.e. a red gate with no reader.

What it would have protected is real, though, and is the reason this directory
survived the change rather than being deleted with the fixture: the moment there
IS a deployed client, a rename like that one has to arrive as a new `v{N}.json`
beside the old, with the old still passing.
