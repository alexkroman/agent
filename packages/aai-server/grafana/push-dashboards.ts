// Copyright 2025 the AAI authors. MIT license.
/**
 * Push aai-agent dashboards to fly-metrics.net.
 *
 * Run: pnpm --filter aai-server push-dashboards [--dry-run]
 *
 * Requires GRAFANA_TOKEN in env (operator-local; never on the server).
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const FOLDER_UID = "aai-agent";
const FOLDER_TITLE = "aai-agent";
const BASE = "https://fly-metrics.net";

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const token = process.env.GRAFANA_TOKEN;
  if (!token) {
    console.error("GRAFANA_TOKEN not set in env");
    process.exit(1);
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const folderUrl = `${BASE}/api/folders`;
  const folderBody = JSON.stringify({ uid: FOLDER_UID, title: FOLDER_TITLE });
  if (dryRun) {
    console.info(`[dry-run] POST ${folderUrl} ${folderBody}`);
  } else {
    const res = await fetch(folderUrl, {
      method: "POST",
      headers,
      body: folderBody,
    });
    // 409/412: folder already exists — non-fatal.
    if (!res.ok && res.status !== 409 && res.status !== 412) {
      console.error(`folder create failed: ${res.status} ${await res.text()}`);
      process.exit(1);
    }
  }

  const dir = path.resolve(import.meta.dirname, "dashboards");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  const url = `${BASE}/api/dashboards/db`;

  let failures = 0;
  for (const f of files) {
    const dashboard = JSON.parse(await readFile(path.join(dir, f), "utf-8"));
    if (dryRun) {
      console.info(`[dry-run] POST ${url} (uid=${dashboard.uid})`);
      continue;
    }
    const body = JSON.stringify({
      dashboard,
      folderUid: FOLDER_UID,
      overwrite: true,
      message: "Updated by push-dashboards.ts",
    });
    const res = await fetch(url, { method: "POST", headers, body });
    if (!res.ok) {
      console.error(`push ${f} failed: ${res.status} ${await res.text()}`);
      failures++;
      continue;
    }
    const result = (await res.json()) as { url?: string };
    console.info(`pushed ${f} -> ${BASE}${result.url ?? ""}`);
  }

  if (failures > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error("Fatal:", err);
  process.exit(1);
});
