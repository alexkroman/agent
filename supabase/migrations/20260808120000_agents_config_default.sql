-- The platform no longer records what a deployed agent IS.
--
-- `aai_platform.agents.config` held the bundle's self-described config,
-- extracted at deploy time by loading the bundle in a throwaway guest
-- sandbox. Nothing ever read a field of it: host mode (the one path where
-- the server's own SDK interpreted a stored config) is gone, and the broker
-- proxies name/greeting from the guest's own /client-config. The column was
-- write-only, and the sandbox spawn that filled it bought nothing — so both
-- are removed. See "The platform stores no agent config" in
-- packages/aai-server/CLAUDE.md.
--
-- This is the EXPAND half of an expand/contract. Migrations run before the
-- deploy and Modal's rolling strategy keeps old containers serving beside
-- new ones, so the column cannot be dropped in the same step: a container
-- still running the previous build names `config` in its insert, and would
-- start failing every deploy for the length of the rollout. A default lets
-- the new build's insert — which omits the column — succeed while the old
-- one still supplies a value.
--
-- The CONTRACT half (`alter table aai_platform.agents drop column config;`)
-- belongs in a later migration, once no serving container writes the column —
-- which means the release AFTER the one carrying this file, not a later
-- commit on the same branch. Landing both together is the exact failure the
-- paragraph above describes.
--
-- It is not left to memory: `platform-schema.test.ts` carries a
-- RETIRED_COLUMNS ledger with an entry for this column, asserting that no
-- platform source writes it and that it is still declared — so the entry has
-- to be deleted in the same commit as the drop, and until then it is a
-- standing item in a test run rather than a paragraph nobody re-reads.
--
-- ── GUARDED, BECAUSE THE CONTRACT HALF HAS SINCE LANDED ─────────────────────
--
-- `20260810030000_drop_agents_config.sql` drops the column, and re-applying
-- this directory is a property the repo maintains ("Idempotent throughout, so
-- re-applying is safe", asserted by `platform-schema.integration.test.ts`
-- against a real Postgres). On a second pass `create table if not exists`
-- no-ops against the already-dropped shape and this statement then raises
-- `42703: column "config" of relation "agents" does not exist`, aborting the
-- whole migration.
--
-- So the statement is conditioned on the column still being there. Editing a
-- migration that has already been applied is normally wrong; it is right here
-- because this changes nothing for any database that ran it (the column
-- existed, the default was set, and it is set again), and restores the
-- directory-wide property its successor broke. The alternative — deleting
-- this file — would skip the expand for a database that has not yet applied
-- it, which is the rollout failure the file exists to prevent.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'aai_platform' and table_name = 'agents' and column_name = 'config'
  ) then
    alter table aai_platform.agents alter column config set default '{}'::jsonb;
  end if;
end $$;
