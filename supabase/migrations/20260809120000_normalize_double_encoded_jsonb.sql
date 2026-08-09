-- Every jsonb column the platform writes has been holding a jsonb STRING
-- instead of an object.
--
-- The stores bind their documents as JSON text with a `$n::jsonb` cast, and
-- postgres.js resolves the parameter's type from that cast and JSON-encodes
-- the string we had already encoded. Measured against a real Postgres:
-- `$3::jsonb` stores `jsonb_typeof = 'string'`; `$3::text::jsonb` stores
-- `'object'`. The code side is fixed in the release carrying this file
-- (workspace-store.ts, agent-store.ts, chat-store.ts,
-- studio-preview-queue.ts); this heals the rows already written.
--
-- It stayed invisible because nothing read these columns from inside Postgres
-- — every reader round-tripped through JS, where the extra layer is peeled off
-- by a tolerance each store grew independently. The two readers that did NOT
-- are exactly the two failures:
--
--   * `studio_workspaces.doc - text[]` (the metadata stamp) raised
--     `cannot delete from scalar`, breaking every preview deploy, Publish and
--     database toggle;
--   * the orphan-preview sweep's `w.doc->>'previewSlug'` read NULL out of a
--     string, so its "is any workspace still pointing at this agent" guard
--     matched nothing and it deleted LIVE preview agents, hourly.
--
-- Idempotent, and safe to run against a database that is already correct: the
-- `jsonb_typeof` guard means a well-formed row is not touched. `#>> '{}'`
-- returns the whole document as text, which `::jsonb` parses back — so the
-- unwrap is exactly one layer and cannot corrupt a legitimate top-level
-- string, of which these columns hold none (every writer sends an object, and
-- `studio_chats.messages` an array).
--
-- Rows written DURING the rollout by a container still on the previous build
-- are not covered — migrations run before the deploy and Modal's rolling
-- strategy keeps old containers serving. That window is why `patch` also
-- normalizes inline rather than relying on this file alone.
update aai_platform.studio_workspaces
  set doc = (doc #>> '{}')::jsonb
  where jsonb_typeof(doc) = 'string';

update aai_platform.studio_chats
  set messages = (messages #>> '{}')::jsonb
  where jsonb_typeof(messages) = 'string';

update aai_platform.agents
  set credential_hashes = (credential_hashes #>> '{}')::jsonb
  where jsonb_typeof(credential_hashes) = 'string';

update aai_platform.agents
  set client_files = (client_files #>> '{}')::jsonb
  where jsonb_typeof(client_files) = 'string';

-- `agents.config` is the column being retired (see
-- 20260808120000_agents_config_default.sql). It is write-only and unread, so
-- it is deliberately left as it is rather than rewritten on its way out.
