// Copyright 2026 the AAI authors. MIT license.
// The cache keys. A key mismatch fails silently (nothing refetches), so the
// properties worth pinning are the ones an invalidation depends on: a prefix
// key really IS the prefix of the keys it is meant to sweep, and the keys that
// must keep two things apart do.

import { matchQuery, QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "vitest";
import { queryKeys } from "./query-keys.ts";

/** Does invalidating `prefix` reach a query cached under `key`? */
function sweeps(prefix: readonly unknown[], key: readonly unknown[]): boolean {
  const client = new QueryClient();
  client.setQueryData(key, 1);
  const query = client.getQueryCache().find({ queryKey: key, exact: true });
  if (!query) throw new Error("query was not cached");
  return matchQuery({ queryKey: prefix }, query);
}

describe("queryKeys", () => {
  test("`accounts` sweeps every bearer's account", () => {
    expect(sweeps(queryKeys.accounts, queryKeys.account("bearer-a"))).toBe(true);
    expect(sweeps(queryKeys.accounts, queryKeys.account("bearer-b"))).toBe(true);
  });

  test("`chatSessions` sweeps every project's chat session, and not the chat", () => {
    expect(sweeps(queryKeys.chatSessions, queryKeys.chatSession("one"))).toBe(true);
    expect(sweeps(queryKeys.chatSessions, queryKeys.chatSession(null))).toBe(true);
    expect(sweeps(queryKeys.chatSessions, queryKeys.chat("one"))).toBe(false);
  });

  test("an account and its GitHub link are per BEARER", () => {
    expect(queryKeys.account("a")).not.toEqual(queryKeys.account("b"));
    expect(queryKeys.github("a")).not.toEqual(queryKeys.github("b"));
    expect(queryKeys.githubRepos("a")).not.toEqual(queryKeys.githubRepos("b"));
  });

  test("the GitHub link and its repositories are separate reads", () => {
    expect(sweeps(queryKeys.github("a"), queryKeys.githubRepos("a"))).toBe(false);
    expect(sweeps(queryKeys.githubRepos("a"), queryKeys.github("a"))).toBe(false);
  });

  test("workflow runs and declarations are keyed by slug, and neither sweeps the other", () => {
    expect(queryKeys.workflowRuns("prod")).not.toEqual(queryKeys.workflowRuns("preview"));
    expect(sweeps(queryKeys.workflowRuns("s"), queryKeys.workflowDeclarations("s"))).toBe(false);
    expect(sweeps(queryKeys.workflowDeclarations("s"), queryKeys.workflowRuns("s"))).toBe(false);
  });

  test("a project, its chat and its chat session do not collide", () => {
    const keys = [queryKeys.project("p"), queryKeys.chat("p"), queryKeys.chatSession("p")];
    expect(new Set(keys.map((k) => JSON.stringify(k))).size).toBe(3);
  });

  test("every root segment is distinct, so no family sweeps another by accident", () => {
    const roots = [
      queryKeys.status,
      queryKeys.account("x"),
      queryKeys.projects,
      queryKeys.github("x"),
      queryKeys.githubRepos("x"),
      queryKeys.project("x"),
      queryKeys.chat("x"),
      queryKeys.chatSession("x"),
      queryKeys.toolLabels("x"),
      queryKeys.secrets("x"),
      queryKeys.workflowRuns("x"),
      queryKeys.workflowDeclarations("x"),
      queryKeys.clientConfig("x"),
    ].map((k) => k[0]);
    expect(new Set(roots).size).toBe(roots.length);
  });

  test("parameterized keys carry their argument verbatim", () => {
    expect(queryKeys.secrets("my-project")).toEqual(["secrets", "my-project"]);
    expect(queryKeys.clientConfig("slug-1")).toEqual(["client-config", "slug-1"]);
    expect(queryKeys.toolLabels(undefined)).toEqual(["tool-labels", undefined]);
  });
});
