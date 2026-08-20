// Copyright 2026 the AAI authors. MIT license.
// The Database pane — what the project's agents have actually STORED, a table
// at a time.
//
// The Settings card that preceded this answered "is the database on" and "how
// many rows are in it", which is the question one step before the one people
// have. A row count moving from 3 to 4 tells you a tool wrote SOMETHING; it
// does not tell you whether the field it wrote is the one you meant, and the
// only way to find out was to ask the coding agent to write a tool that reads
// the table back — a debugging loop that costs a turn and an edit to the
// project. The switch stays in Settings, where the rest of the project's
// configuration is; looking at data is its own pane.
//
// **The environment is an explicit choice, never a default.** Production and
// preview are separate agents with separate schemas, and "my tool saved
// nothing" versus "my tool saved it in the preview" is the single most likely
// confusion this pane can either cause or resolve. So the picker is always
// visible, the pane names the slug that answered, and the read carries the
// environment all the way to the server, which 400s a value it does not know
// rather than picking one.
//
// It is deliberately READ-ONLY. Editing a tenant's rows from a console is a
// different feature with a different blast radius (no undo, no migration, no
// record of who did it), and nothing here needs it to answer the question the
// pane exists for.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type DatabaseEnvironmentName, type TableSummary } from "./api.ts";
import { PaneShell } from "./pane-shell.tsx";
import { queryKeys } from "./query-keys.ts";
import { Card } from "./settings-card.tsx";

/** Rows per page. Matches the server's default; its own cap is higher. */
const PAGE_SIZE = 50;

const ENVIRONMENTS: readonly { id: DatabaseEnvironmentName; label: string }[] = [
  { id: "production", label: "Production" },
  { id: "preview", label: "Preview" },
];

/** A table's identity, as the pane holds a selection. */
type Selection = { schema: string; name: string };

/** Whether two selections name the same table. */
function sameTable(a: Selection | undefined, b: Selection): boolean {
  return a?.schema === b.schema && a?.name === b.name;
}

/**
 * The selected table, or the first one — a function of the two inputs rather
 * than state kept in step by an effect, the same rule the Code pane's open
 * file follows: a selection the listing no longer has is not a selection, and
 * there is nothing to remember about it.
 */
function openTable(picked: Selection | undefined, tables: TableSummary[]): Selection | undefined {
  if (picked !== undefined && tables.some((table) => sameTable(picked, table))) return picked;
  const first = tables[0];
  return first === undefined ? undefined : { schema: first.schema, name: first.name };
}

/** `schema.table`, or just the table where the schema is the ordinary one. */
function tableLabel(table: Selection): string {
  return table.schema === "public" ? table.name : `${table.schema}.${table.name}`;
}

type DatabasePaneProps = { bearer: string; project: string };

export function DatabasePane({ bearer, project }: DatabasePaneProps) {
  const [environment, setEnvironment] = useState<DatabaseEnvironmentName>("production");
  const [picked, setPicked] = useState<Selection | undefined>(undefined);
  const [page, setPage] = useState(0);

  const listing = useQuery({
    queryKey: queryKeys.tables(project, environment),
    queryFn: () => api.listTables(bearer, project, environment),
    retry: false,
  });

  const tables = listing.data?.tables ?? [];
  const table = openTable(picked, tables);

  return (
    <PaneShell
      title="Database"
      subtitle="The rows your agent's tools have written. Read-only — switch the database on or off in Settings."
    >
      <Card
        title="Environment"
        blurb="Each deployed agent has its own schema, so a row written by the preview is not in production and never will be. This is which one you are looking at."
      >
        <div className="flex items-center gap-3">
          <div className="flex flex-none overflow-hidden rounded-sm border border-line">
            {ENVIRONMENTS.map((option, i) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={environment === option.id}
                className={`seg ${i > 0 ? "border-l border-line " : ""}${
                  environment === option.id ? "bg-fg text-cream" : "bg-panel text-muted"
                }`}
                onClick={() => {
                  setEnvironment(option.id);
                  // The other environment's tables are a different set, so a
                  // selection and a page offset from this one mean nothing
                  // there — carried over, they read as an empty table.
                  setPicked(undefined);
                  setPage(0);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
          {listing.data && (
            <code className="min-w-0 truncate font-mono text-[11px] text-subtle">
              {listing.data.slug}
            </code>
          )}
        </div>
      </Card>

      <Card
        title="Tables"
        blurb="Every table in this environment's schema, with the exact number of rows in it — counted live, so a row written a second ago is included."
      >
        {listing.isPending && (
          <p className="m-0 text-[13px] text-muted" role="status">
            Reading tables…
          </p>
        )}
        {/* One sentence for every "nothing to read": the server answers 404
            for an environment that has not deployed, a database switched off,
            and a project whose slug this caller does not own — see
            studio-database-browse.ts for why it does not distinguish them. */}
        {listing.isError && (
          <p className="m-0 text-[13px] leading-5 text-muted">
            No database to read here yet. This environment has to be deployed with the database
            switched on before it has tables.
          </p>
        )}
        {listing.data?.tables.length === 0 && (
          <p className="m-0 text-[13px] leading-5 text-muted">
            The database is on and empty — no tables yet. A tool that calls{" "}
            <code className="font-mono">ctx.db</code> creates them as it writes.
          </p>
        )}
        {tables.length > 0 && (
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
            {tables.map((entry) => {
              const selected = table !== undefined && sameTable(table, entry);
              return (
                <li key={`${entry.schema}.${entry.name}`}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    className={`btn px-2 py-1 text-xs ${selected ? "border-fg text-fg" : ""}`}
                    onClick={() => {
                      setPicked({ schema: entry.schema, name: entry.name });
                      setPage(0);
                    }}
                  >
                    <span className="font-mono">{tableLabel(entry)}</span>
                    <span className="ml-2 text-subtle">{entry.rows}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {table && (
        <TableView
          bearer={bearer}
          project={project}
          environment={environment}
          table={table}
          page={page}
          onPage={setPage}
        />
      )}
    </PaneShell>
  );
}

/**
 * One table's rows.
 *
 * Its own component so the page read is keyed by the table and unmounts with
 * it: holding the query up in the pane would keep the previous table's rows on
 * screen under the new table's heading while the next read was in flight,
 * which is the one wrong answer a data viewer can give.
 */
function TableView({
  bearer,
  project,
  environment,
  table,
  page,
  onPage,
}: {
  bearer: string;
  project: string;
  environment: DatabaseEnvironmentName;
  table: Selection;
  page: number;
  onPage: (page: number) => void;
}) {
  const offset = page * PAGE_SIZE;
  const rows = useQuery({
    queryKey: queryKeys.tableRows(project, environment, table.schema, table.name, offset),
    queryFn: () =>
      api.readTable(bearer, project, {
        environment,
        schema: table.schema,
        table: table.name,
        limit: PAGE_SIZE,
        offset,
      }),
    retry: false,
  });

  const total = rows.data?.total ?? 0;
  const shown = rows.data?.rows.length ?? 0;
  const last = offset + shown >= total;

  return (
    <Card
      title={tableLabel(table)}
      blurb={
        rows.data
          ? `${total} row${total === 1 ? "" : "s"}, ${rows.data.columns.length} column${
              rows.data.columns.length === 1 ? "" : "s"
            }.`
          : "Reading rows…"
      }
    >
      {rows.isError && <p className="m-0 text-[13px] text-err">{rows.error.message}</p>}
      {rows.data && rows.data.rows.length === 0 && (
        <p className="m-0 text-[13px] text-muted">No rows.</p>
      )}
      {rows.data && rows.data.rows.length > 0 && (
        // The table scrolls INSIDE its own box. A wide one must not stretch
        // the pane and give the whole studio a horizontal scrollbar.
        <div className="min-w-0 overflow-x-auto rounded-md border border-line">
          <table className="w-full border-collapse text-left font-mono text-[11px]">
            <thead>
              <tr>
                {rows.data.columns.map((column) => (
                  <th
                    key={column}
                    className="border-b border-line bg-cream px-3 py-2 font-medium whitespace-nowrap text-muted"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.data.rows.map((row, index) => (
                // The row's position IS its identity here: a page of arbitrary
                // tenant rows has no key of its own to use, and the array is
                // replaced wholesale by every read.
                <tr key={`${offset + index}`} className="border-b border-line last:border-b-0">
                  {row.map((value, cell) => (
                    <td
                      key={rows.data.columns[cell] ?? String(cell)}
                      className="max-w-80 truncate px-3 py-2 align-top"
                      title={value ?? undefined}
                    >
                      {/* NULL is rendered as a value, not as blank: a text
                          column may legitimately hold the empty string, and
                          those two must not look identical. */}
                      {value === null ? <span className="text-subtle italic">NULL</span> : value}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {total > PAGE_SIZE && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="btn px-2 py-1 text-xs"
            disabled={page === 0 || rows.isFetching}
            onClick={() => onPage(page - 1)}
          >
            Previous
          </button>
          <span className="text-[11px] text-muted">
            {offset + 1}–{offset + shown} of {total}
          </span>
          <button
            type="button"
            className="btn px-2 py-1 text-xs"
            disabled={last || rows.isFetching}
            onClick={() => onPage(page + 1)}
          >
            Next
          </button>
        </div>
      )}
    </Card>
  );
}
