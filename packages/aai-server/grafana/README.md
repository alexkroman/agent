# aai-agent Grafana dashboards

These dashboards are pushed to https://fly-metrics.net and live in the
`aai-agent` folder. They are the source of truth — UI edits are
overwritten on next push.

## One-time setup

1. Visit https://fly-metrics.net (sign in with Fly).
2. Administration → Service Accounts → "Add service account".
   - Name: `aai-dashboards-pusher`
   - Role: `Editor`
3. Add a token; copy it.
4. On your laptop, set:
   ```
   export GRAFANA_TOKEN=<paste>
   ```

## Push

```sh
pnpm --filter aai-server push-dashboards
```

Add `-- --dry-run` to see the planned requests without making any HTTP calls.

## Dashboards

| URL | Question |
| --- | --- |
| `/d/aai-overview/aai-agent-overview` | Is the platform healthy right now? |
| `/d/aai-capacity/aai-agent-capacity` | Can it take more load? |
| `/d/aai-agents/aai-agent-agents` | Which tenant is hot/broken? |
| `/d/aai-providers/aai-agent-providers` | Is it us or upstream? |

## Adding a metric

1. Define it in `packages/aai-server/metrics.ts` and export via the
   `metrics` object.
2. Add a unit test in `metrics.test.ts`.
3. If the metric carries a `slug` label, extend the permitlist in
   `metrics-cardinality.test.ts` deliberately.
4. Reference it from a dashboard panel; the
   `grafana/promql-references.test.ts` will fail if the name doesn't match.
5. `pnpm --filter aai-server push-dashboards` to publish.

## Adding a dashboard

1. Author `packages/aai-server/grafana/dashboards/<name>.json` with a
   pinned `uid` like `aai-<name>`.
2. The promql-references test runs over all `*.json` automatically.
3. Push.
