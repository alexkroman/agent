# aai-agent Grafana dashboards

These four dashboards are the source of truth for the operator views of
`aai-agent`. The JSON in this directory is what gets imported into
Grafana; UI edits are not authoritative.

| File | UID | Question it answers |
| --- | --- | --- |
| `dashboards/overview.json` | `aai-overview` | Is the platform healthy right now? |
| `dashboards/capacity.json` | `aai-capacity` | How much capacity is used and how much is left? |
| `dashboards/agents.json` | `aai-agents` | Which tenant is hot/broken? |
| `dashboards/providers.json` | `aai-providers` | Is it us or upstream? |

## Importing into [fly-metrics.net](https://fly-metrics.net)

Fly's managed Grafana does not expose a programmatic dashboard API
(no service-account tokens, no API keys). Use the UI:

1. Sign in to <https://fly-metrics.net>.
2. Top-left **+** → **Import dashboard**.
3. **Upload JSON file** → pick one of the four `dashboards/*.json`.
4. Set the Prometheus data source to your Fly Prometheus.
5. Click **Import**.
6. Repeat for the other three.

To re-sync after editing a dashboard JSON, repeat the same flow with
**Overwrite existing** ticked. The pinned `uid` in each file makes
Grafana update in place.

## Importing into self-hosted Grafana or Grafana Cloud

If you run your own Grafana (on Fly, Grafana Cloud, or anywhere else),
you can push dashboards programmatically:

1. Create a Grafana **service account** with **Editor** role.
2. Generate a service-account token, copy it.
3. Export the token locally:

   ```sh
   export GRAFANA_TOKEN=glsa_xxxxx
   ```

4. Push:

   ```sh
   pnpm --filter aai-server push-dashboards               # live push
   pnpm --filter aai-server push-dashboards -- --dry-run  # preview
   ```

The script targets `https://fly-metrics.net` by default. For other
Grafana hosts, edit the `BASE` constant in `push-dashboards.ts`.

## Current operational SLO

The capacity dashboard treats "100% used" as "at the operational
ceiling," not "at the physical max." If a dimension is yellow/red on a
healthy fleet, adjust the multiplier in `dashboards/capacity.json` —
no metrics-code change needed.

| Dimension | Ceiling |
| --- | --- |
| Memory | 80% of `aai_machine_memory_bytes` |
| CPU | 70% of `aai_machine_cpu_cores` |
| Event-loop lag p99 | 50 ms |
| Sandbox cold-start p95 | 1.0 s |
| Session error rate | 1% |
| Warm pool ready | 50% of target (alert when half-empty) |

## Adding a metric

1. Define it in `packages/aai-server/metrics.ts` and export via the
   `metrics` object.
2. Add a unit test in `metrics.test.ts`.
3. If the metric carries a `slug` label, extend the permitlist in
   `metrics-cardinality.test.ts` deliberately.
4. Reference it from a dashboard panel; the
   `grafana/promql-references.test.ts` will fail if the name does not
   match a registered metric.
5. Re-import the affected dashboard via the UI.

## Adding a dashboard

1. Author `dashboards/<name>.json` with a pinned `uid` like
   `aai-<name>`.
2. The promql-references test runs over all `*.json` automatically.
3. Import via the UI.
