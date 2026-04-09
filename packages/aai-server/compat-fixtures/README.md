# RPC Compatibility Fixtures

Pinned JSON snapshots of valid RPC responses from agent isolates. These
protect the server-to-isolate boundary — if the isolate returns a response
that the host can no longer parse, deployed agents break.

## When to create a new version

Create a new `v{N}.json` when you intentionally change the RPC schemas
and have confirmed all deployed agent bundles have been updated.

## Rules

- **Never modify** an existing fixture file after it's committed.
- **Never delete** a fixture unless you're certain no deployed code depends
  on that version.

## What's covered

- `IsolateConfig` — agent config returned by the `config` RPC
- `ToolCallResponse` — tool execution results
