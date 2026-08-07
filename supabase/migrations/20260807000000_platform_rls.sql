-- Deny-all row-level security on the platform schema.
--
-- This is DEFENSE IN DEPTH, not access control, and the distinction decides
-- everything about how it is written.
--
-- Nothing the platform does goes through RLS. It connects as the table OWNER
-- (`postgres`, over SUPABASE_DB_URL) and owners bypass policies; Realtime
-- subscribes as `service_role`, which holds BYPASSRLS — which is exactly why
-- Supabase's own docs say never to hand that key to a client. So every
-- statement below is inert for every path in use today.
--
-- What they change is the FAILURE MODE of a mistake nobody would catch.
-- Until now, the only thing between a browser and every tenant's workspace
-- was the ABSENCE of a grant (see the grant block in the platform-schema
-- migration). Add `grant select … to authenticated`, or add `aai_platform` to
-- the project's exposed-schema list, and every row becomes readable — with
-- nothing anywhere reporting it, because Supabase's linter (splinter rule
-- 0013, `rls_disabled_in_public`) and the RLS-disabled email alerts both key
-- on the `public` schema, which this is not. With RLS enabled and no policies,
-- that same mistake returns zero rows.
--
-- ENABLE, never FORCE. `force row level security` applies policies to the
-- table owner as well — and the owner is every query the platform makes, so
-- forcing it would lock the service out of its own control plane. There is a
-- test asserting the word never appears here.
--
-- NO POLICIES, on purpose. A policy would be a claim that some non-owner role
-- ought to read these tables. None should: every legitimate reader is the
-- platform itself, holding the owner or service-role connection. If a browser
-- ever reads `aai_platform` directly, that is a design change (see
-- `packages/aai-server/CLAUDE.md`, "Where we differ from Supabase's own
-- recommendations") and it arrives with its own policies.
--
-- ── VERIFY ON STAGING BEFORE THIS REACHES PRODUCTION ────────────────────────
--
-- These statements rest on one claim that cannot be checked from a test
-- suite: that walrus — Realtime's per-subscriber row-visibility filter — still
-- sees rows for a BYPASSRLS subscriber once RLS is enabled on the table. It
-- should, and the failure if it does not is the SILENT one this platform has
-- already been bitten by: filtered subscribes stop, the service boots healthy,
-- and it merely stops invalidating resident sandboxes and pushing studio SSE.
--
-- So confirm two things against a staging project with this applied, both of
-- which exercise the change stream end to end:
--   1. Editing a studio workspace still pushes a `project` frame on
--      `GET /studio/projects/:project/events`.
--   2. Redeploying an agent still retires the resident sandbox for its slug
--      (a `Sandbox retired` / handover log line, not a silent no-op).
-- If either is dead, the cause is this migration and not the network.

alter table aai_platform.agents enable row level security;
alter table aai_platform.studio_workspaces enable row level security;
alter table aai_platform.studio_chats enable row level security;

-- Not in the publication, and covered for the same reason: they hold the same
-- tenant-identifying data (a scope hash, a project name, live sandbox tokens)
-- and carry the same accidental-grant risk. `studio_sessions` is the sharper
-- of the two — its rows contain a guest's `chat_token` and `sandbox_token`.
alter table aai_platform.studio_rate_limits enable row level security;
alter table aai_platform.studio_sessions enable row level security;
