-- A project's chat and its live session belong to its workspace. Say so.
--
-- Deleting a project ran `deleteWorkspace` and `deleteChat` side by side in a
-- `Promise.all`, unlocked. If the chat leg lost — a transient error, a replica
-- dying mid-request — the workspace went and the chat row stayed, and NOTHING
-- would ever reap it: no sweep covers `studio_chats`, and the only code path
-- that deletes one is the delete of a project that no longer exists. The row
-- is invisible from every surface and permanent.
--
-- `studio_sessions` was looser still: project deletion never released the row
-- at all, so it lived until its lease expired — carrying a live `chat_token`
-- and `sandbox_token` for a project that is gone.
--
-- A composite foreign key makes both the database's job. The application-level
-- deletes stay — they are what the in-memory stores do in dev and tests — and
-- this is the backstop under them.
--
-- For `studio_sessions` it is not a backstop but the WHOLE mechanism: the
-- delete route (`studio-routes.ts`) touches the workspace and the chat and
-- nothing else, so before this the row simply outlived the project. Nothing
-- releases the guest on that path either, with or without the cascade — the
-- owning replica's idle sweeper is what disposes a studio sandbox, and it
-- disposes this one SOONER once the lease row is gone, since `get` stops
-- reporting the project as recently brokered. So the cascade is strictly an
-- improvement on both counts; it just is not a release.
--
-- ── ORDERING, WHICH IS WHAT MAKES THIS SAFE ─────────────────────────────────
--
-- A foreign key turns "no workspace row" from silently-fine into an error, so
-- every writer of a child row must run after the workspace exists. All three
-- do:
--
--   * `studio_chats` is written by `studio/persist-chat`, an end-of-turn RPC
--     from a guest whose session was brokered against an existing project.
--   * `studio_sessions` is written by `fleet.claim`, downstream of the same
--     broker route (which 404s on a missing workspace).
--   * Project creation writes the workspace first (`createWorkspace`), before
--     anything can reference it.
--
-- The remaining case is a genuine race — a write landing after a concurrent
-- project delete — and both call sites already treat failure as survivable:
-- `fleet.claim` catches and warns ("peers may duplicate"), and a rejected
-- `persist-chat` fails one RPC for a project that no longer exists, which is
-- the correct outcome rather than a regression.
--
-- Orphans are cleared first, because an `add constraint` validates existing
-- rows and would otherwise fail against exactly the residue this exists to
-- prevent.
delete from aai_platform.studio_chats c
where not exists (
  select 1 from aai_platform.studio_workspaces w
  where w.scope = c.scope and w.project = c.project
);

delete from aai_platform.studio_sessions s
where not exists (
  select 1 from aai_platform.studio_workspaces w
  where w.scope = s.scope and w.project = s.project
);

-- `if not exists` is not available for `add constraint`, hence the catalog
-- check — the same idempotency every other statement in this directory has.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'studio_chats_workspace_fk'
  ) then
    alter table aai_platform.studio_chats
      add constraint studio_chats_workspace_fk
      foreign key (scope, project)
      references aai_platform.studio_workspaces (scope, project)
      on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'studio_sessions_workspace_fk'
  ) then
    alter table aai_platform.studio_sessions
      add constraint studio_sessions_workspace_fk
      foreign key (scope, project)
      references aai_platform.studio_workspaces (scope, project)
      on delete cascade;
  end if;
end $$;
