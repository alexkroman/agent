-- The change streams are SIGNALS, so publish only the columns that identify
-- the row.
--
-- `realtime-events.ts` states the contract outright: "Handlers receive
-- SIGNALS, not payloads — watchers re-read the row." Nothing downstream has
-- ever read a field off a `postgres_changes` payload. The publication did not
-- know that, and published every column, so each of these tables paid the full
-- cost of shipping a document nobody would look at:
--
--   * `studio_workspaces.doc` is the WHOLE project file map. Every settled
--     edit, every metadata stamp (`previewSlug`, `deployedHash`,
--     `databaseEnabled`), every preview deploy wrote it into the WAL, where
--     walrus DETOASTED it, checked the subscription filter, serialized it to
--     JSON, and handed it to a handler that discards it and re-reads the row.
--     All of that on the single ordering thread the whole project's Realtime
--     shares.
--   * `agents.client_files` and `credential_hashes` did the same, per deploy,
--     to every replica.
--
-- Past `max_record_bytes` (1 MB by default) walrus replaces an oversized
-- record with an error payload instead — survivable here ONLY because nothing
-- reads it, which is the point: a growing project silently changed what
-- arrived on the wire and no behaviour changed with it. That is a fact worth
-- removing rather than relying on.
--
-- ── WHAT MAY BE DROPPED, AND WHY THESE COLUMNS STAY ─────────────────────────
--
-- Two constraints decide the lists below, and both are load-bearing:
--
--   1. **Every column a channel FILTERS on must stay published.** The filters
--      live in `realtime-events.ts`: `project=eq.<name>` for the workspace and
--      chat channels, `scope=eq.<hash>` for the scope channel. The other half
--      of each composite key is checked handler-side against the payload
--      (`scopeAccepts` reads `row.scope`), so that column has to arrive too.
--   2. **Postgres requires the replica identity columns in any column list.**
--      Replica identity here is the primary key — `agents(slug)`,
--      `studio_workspaces(scope, project)`, `studio_chats(scope, project)` —
--      which is exactly the set rule 1 already demands. That is not a
--      coincidence: the handlers were designed to key off row identity.
--
-- `version` is not needed by any handler (`watchAgents` re-reads it; the
-- workspace watchers re-read the whole row) and is kept anyway — it is 8 bytes
-- and it makes a raw change record legible when someone is debugging why a
-- deploy did or did not invalidate.
--
-- ── DROP-THEN-ADD, NEVER `SET TABLE` ────────────────────────────────────────
--
-- `alter publication … set table …` replaces the publication's ENTIRE table
-- list, so using it here would silently unpublish anything else the project
-- has in `supabase_realtime` (a `public` table added from the dashboard, say).
-- Per-table `drop` + `add` touches only what it names. Both run inside this
-- migration's transaction, so no window exists where a watched table is
-- absent from the publication.
--
-- Unconditionally re-applied rather than compared against `pg_publication_rel.
-- prattrs`: ending in the desired state is simpler to be sure of than
-- detecting whether we are already there, and re-running costs one catalog
-- update per table.
do $$
declare
  target record;
begin
  for target in
    select *
    from (values
      ('agents',            'slug, version'),
      ('studio_workspaces', 'scope, project, version'),
      ('studio_chats',      'scope, project')
    ) as t(tablename, columns)
  loop
    if exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'aai_platform'
        and tablename = target.tablename
    ) then
      execute format(
        'alter publication supabase_realtime drop table aai_platform.%I',
        target.tablename
      );
    end if;
    execute format(
      'alter publication supabase_realtime add table aai_platform.%I (%s)',
      target.tablename, target.columns
    );
  end loop;
end $$;
