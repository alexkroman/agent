// Copyright 2026 the AAI authors. MIT license.
// The Database pane's two reads: one environment's tables, and one page of one
// table.
//
// Its own module because `api.ts` is at the 500-line cap, and this is the
// natural seam — every other method there is about the PROJECT (its files, its
// chat, its secrets, its deploys) while these two are about what a deployed
// agent has stored. They are spread into the one `api` object, so a caller
// still sees a single surface.
//
// The `request` function is passed IN rather than imported, which is what
// keeps the dependency one-way: `api.ts` owns the bearer, the deadline and the
// `/studio` prefix, and importing it back from here would be a cycle between
// two modules that are really one surface.

import type { DatabaseEnvironmentName, TableListing, TablePage } from "./api-types.ts";

/** `api.ts`'s studio-surface request, narrowed to what these two reads use. */
type StudioRequest = <T>(key: string, path: string) => Promise<T>;

/** Everything one page read needs to name its target. */
export type ReadTableParams = {
  environment: DatabaseEnvironmentName;
  schema: string;
  table: string;
  limit: number;
  offset: number;
};

/** The project's path prefix, encoded once. */
function projectPath(project: string): string {
  return `/projects/${encodeURIComponent(project)}/database`;
}

export function tableReads(request: StudioRequest) {
  return {
    /**
     * One environment's tables, for the Database pane's viewer.
     *
     * The environment is NAMED rather than defaulted, all the way to the
     * server: production and preview keep separate schemas, so "my tool saved
     * nothing" and "my tool saved it in the preview" are the two answers this
     * distinguishes, and a pane that let the server pick could report either
     * one under the other's heading.
     */
    listTables: (key: string, project: string, environment: DatabaseEnvironmentName) =>
      request<TableListing>(key, `${projectPath(project)}/tables?environment=${environment}`),

    /** One page of one table. `schema` and `table` come from `listTables`. */
    readTable: (key: string, project: string, params: ReadTableParams) => {
      const query = new URLSearchParams({
        environment: params.environment,
        schema: params.schema,
        table: params.table,
        limit: String(params.limit),
        offset: String(params.offset),
      });
      return request<TablePage>(key, `${projectPath(project)}/rows?${query.toString()}`);
    },
  };
}
