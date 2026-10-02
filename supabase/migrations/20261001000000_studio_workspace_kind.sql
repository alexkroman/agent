-- Every studio workspace document carries a `kind`.
--
-- `kind` (`agent` | `workflow`) selects the coding agent's system prompt at
-- every session install. Documents written before the new-project switcher
-- existed have none, and the reader used to resolve an absent one to `agent`
-- on every read. The release carrying this file removes that fallback:
-- `parseWorkspace` (`aai-studio-server/src/studio-workspace.ts`) reads a
-- document without a valid `kind` as malformed, and every writer stamps one
-- (`POST /studio/projects` requires it, `aai push`'s first push stamps
-- `agent`). This stamps `agent` — what those projects were built as — on the
-- rows already written, so none of them reads as missing.
--
-- Idempotent: a document whose `kind` is already one of the two is not
-- touched. A value that is neither (hand-edited) is overwritten, because the
-- reader would refuse it.
--
-- Rows written DURING the rollout by a container still on the previous build
-- (a first `aai push`, which used to store no `kind`) are not covered —
-- migrations run before the deploy and Modal's rolling strategy keeps old
-- containers serving. Re-running this file heals them.
update aai_platform.studio_workspaces
set doc = jsonb_set(doc, '{kind}', '"agent"'::jsonb)
where coalesce(doc ->> 'kind', '') not in ('agent', 'workflow');
