// Copyright 2026 the AAI authors. MIT license.
// The Settings pane's Database card: one switch that gives the project's
// tools `ctx.db` in BOTH environments — the auto-deployed preview agent and
// the published production agent — each with its own Postgres schema.
//
// It was CLI-only before (`aai storage enable <slug>`), which meant the one
// capability the coding agent cannot provision for itself was also the one
// the studio's users had no way to turn on. Per-slug is the platform
// primitive; a project is two slugs, so the switch is per PROJECT and the
// server fans it out (aai-studio-server/studio-database.ts).
//
// Two things the copy has to be honest about, because both are visible: the
// database reaches an agent when that agent is next DEPLOYED (its sandbox
// reads DATABASE_URL at boot), so the preview redeploys itself while
// production waits for a Publish; and disabling drops the schemas with all
// their data.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type DatabaseEnvironment, type DatabaseState } from "./api.ts";
import { errorText } from "./api-error.ts";
import { queryKeys } from "./query-keys.ts";
import { Card } from "./settings-card.tsx";

const ENVIRONMENT_LABELS: Record<DatabaseEnvironment["environment"], string> = {
  production: "Production",
  preview: "Preview",
};

/** What an environment without a database yet is waiting for. */
const PENDING_LABELS: Record<DatabaseEnvironment["environment"], string> = {
  production: "Publish to create it",
  preview: "Deploying now",
};

/**
 * Bytes as a short human string. Binary units, because this is disk.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal below 10 so 1.4 MB doesn't read as 1 MB; none above, where it
  // is noise.
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * What the row says on the right, which is the whole reason for the numbers:
 * "Ready" answers whether the switch took effect and says nothing about
 * whether the agent is WRITING anything — the question people actually have
 * when a tool looks like it saved something and the next call can't find it.
 * An enabled schema with no tables therefore reads as "no data yet" rather
 * than as the reassuring "Ready" it used to.
 */
function usageText(row: DatabaseEnvironment): string {
  if (!row.enabled) return PENDING_LABELS[row.environment];
  const usage = row.usage;
  // A read that failed is not an empty database — say nothing rather than 0.
  if (!usage) return "Ready";
  if (usage.tables === 0) return "Ready · no tables yet";
  return `${plural(usage.tables, "table")} · ${plural(usage.rows, "row")} · ${formatBytes(usage.bytes)}`;
}

function EnvironmentRow({ row }: { row: DatabaseEnvironment }) {
  return (
    <li className="flex items-center gap-3 border-b border-line bg-cream px-3 py-2 last:border-b-0">
      <span className="w-24 shrink-0 text-xs text-fg">{ENVIRONMENT_LABELS[row.environment]}</span>
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted">
        {row.slug ?? "not deployed yet"}
      </code>
      <span className="shrink-0 text-[11px] text-subtle">{usageText(row)}</span>
    </li>
  );
}

type DatabaseCardProps = {
  bearer: string;
  project: string;
  /** Post a note into the chat so the coding agent knows what it may build on. */
  onNotifyChat: (text: string) => void;
};

/** The chat note for each direction — the agent's only signal that this changed. */
const ENABLED_NOTE =
  "I enabled the database for this project from the Settings pane. `ctx.db` is available to " +
  "the preview agent, and to the production agent after the next publish — each environment " +
  "has its own schema. Build anything that must outlive a call on it (create tables lazily " +
  "with `create table if not exists`).";

const DISABLED_NOTE =
  "I disabled the database for this project from the Settings pane. `ctx.db` now throws — " +
  "move any persistence off it, or ask me to turn it back on.";

export function DatabaseCard({ bearer, project, onNotifyChat }: DatabaseCardProps) {
  const queryClient = useQueryClient();

  const database = useQuery<DatabaseState>({
    queryKey: queryKeys.database(project),
    queryFn: () => api.getDatabase(bearer, project),
  });

  const set = useMutation({
    mutationFn: (next: boolean) =>
      next ? api.enableDatabase(bearer, project) : api.disableDatabase(bearer, project),
    onSuccess: (state, next) => {
      // The response IS the new state, so seed the cache with it rather than
      // invalidating: a re-read costs a credential lookup per environment.
      queryClient.setQueryData(queryKeys.database(project), state);
      onNotifyChat(next ? ENABLED_NOTE : DISABLED_NOTE);
    },
  });

  const state = database.data;
  const enabled = state?.enabled === true;
  const unavailable = state?.configured === false;
  // A partial failure (`warning`) is the state's own report, so it renders in
  // the same place as a failed request.
  const message = errorText(database.error ?? set.error) ?? state?.warning;

  const onToggle = () => {
    if (set.isPending) return;
    if (
      enabled &&
      !window.confirm(
        "Disable the database? Both environments' schemas are dropped, with all their data. " +
          "This cannot be undone.",
      )
    ) {
      return;
    }
    set.mutate(!enabled);
  };

  return (
    <Card title="Database" blurb={<Blurb enabled={enabled} unavailable={unavailable} />}>
      {enabled && state && (
        <>
          <ul className="m-0 flex list-none flex-col overflow-hidden rounded-md border border-line p-0">
            {state.environments.map((row) => (
              <EnvironmentRow key={row.environment} row={row} />
            ))}
          </ul>
          {/* The counts are read live, so they are as old as this card's last
              fetch — which is a problem exactly when they matter: you make a
              call, then want to know whether it landed. */}
          <button
            type="button"
            className="btn self-start px-2 py-1 text-xs"
            onClick={() => void database.refetch()}
            disabled={database.isFetching}
          >
            {database.isFetching ? "Refreshing…" : "Refresh counts"}
          </button>
        </>
      )}
      {!unavailable && (
        <>
          <button
            type="button"
            className={
              enabled ? "btn self-start text-err hover:border-err" : "btn btn-primary self-start"
            }
            onClick={onToggle}
            disabled={database.isPending || set.isPending}
          >
            {set.isPending && (enabled ? "Disabling…" : "Enabling…")}
            {!set.isPending && (enabled ? "Disable database" : "Enable database")}
          </button>
          {enabled && (
            <p className="m-0 text-xs text-subtle">
              An agent picks the database up when it is next deployed: the preview redeploys on its
              own, production when you publish.
            </p>
          )}
        </>
      )}
      {message && <p className="m-0 text-xs text-err">{message}</p>}
    </Card>
  );
}

function Blurb({ enabled, unavailable }: { enabled: boolean; unavailable: boolean }) {
  if (unavailable) {
    return <>This server has no database configured, so ctx.db is unavailable here.</>;
  }
  if (enabled) {
    return (
      <>
        Tools can persist data with <code className="font-mono">ctx.db</code>. The preview and
        production agents each get their OWN schema, so trying something out can never touch
        published data.
      </>
    );
  }
  return (
    <>
      Give this project's tools a SQL database, reached as <code className="font-mono">ctx.db</code>{" "}
      — for anything that has to outlive a single call. Off by default; scratch that only one call
      needs belongs in <code className="font-mono">ctx.state</code>.
    </>
  );
}
