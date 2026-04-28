// Copyright 2025 the AAI authors. MIT license.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// Importing the orchestrator for its side effect: at module load it calls
// `prometheus({ registry })`, which registers `http_requests_total` and
// `http_request_duration_seconds` on the shared registry. Without this
// import those metrics would only appear after a request had flowed
// through the middleware, leaving the assertion below flaky.
import "../orchestrator.ts";
import { registry } from "../metrics.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const METRIC_NAME_RE = /\b(aai_[a-z0-9_]+|http_[a-z0-9_]+|nodejs_[a-z0-9_]+|process_[a-z0-9_]+)\b/g;
const DASHBOARDS_DIR = path.resolve(__dirname, "dashboards");

type Target = { expr?: string };
type Panel = { targets?: Target[] };
type Dashboard = { uid?: unknown; panels?: Panel[] };

function baseName(name: string): string {
  return name
    .replace(/_bucket$/, "")
    .replace(/_count$/, "")
    .replace(/_sum$/, "");
}

async function loadDashboards(): Promise<Dashboard[]> {
  const files = (await readdir(DASHBOARDS_DIR)).filter((f) => f.endsWith(".json"));
  return Promise.all(
    files.map(
      async (f) => JSON.parse(await readFile(path.join(DASHBOARDS_DIR, f), "utf-8")) as Dashboard,
    ),
  );
}

function collectExprs(dashboards: Dashboard[]): string[] {
  const exprs: string[] = [];
  for (const d of dashboards) {
    for (const p of d.panels ?? []) {
      for (const t of p.targets ?? []) {
        if (t.expr) exprs.push(t.expr);
      }
    }
  }
  return exprs;
}

function referencedMetrics(exprs: string[]): Set<string> {
  const referenced = new Set<string>();
  for (const expr of exprs) {
    for (const match of expr.matchAll(METRIC_NAME_RE)) {
      const name = match[1];
      if (name) referenced.add(baseName(name));
    }
  }
  return referenced;
}

describe("promql references", () => {
  it("every metric referenced in dashboard expr exists in the registry", async () => {
    const dashboards = await loadDashboards();
    const referenced = referencedMetrics(collectExprs(dashboards));
    const registered = new Set(registry.getMetricsAsArray().map((m) => m.name));
    const missing = [...referenced].filter((m) => !registered.has(m));
    expect(missing).toEqual([]);
  });

  it("every dashboard pins a stable uid", async () => {
    const dashboards = await loadDashboards();
    for (const d of dashboards) {
      expect(typeof d.uid).toBe("string");
      expect((d.uid as string).startsWith("aai-")).toBe(true);
    }
  });
});
