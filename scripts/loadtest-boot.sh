#!/usr/bin/env bash
# Scaffold template agents and run each on its own `aai dev` server, against a
# local Postgres.
#
#   ./scripts/loadtest-boot.sh                       # default template set
#   AGENTS="simple retail" ./scripts/loadtest-boot.sh
#   WORKDIR=/tmp/agents ./scripts/loadtest-boot.sh
#   ./scripts/loadtest-boot.sh stub                  # the STUBBED-PROVIDER agent
#
# `stub` is the one that can be driven through full TURNS: it scaffolds `simple`
# and copies `loadtest-stub-agent/` over it, so all three provider stages are
# local fakes and a turn rate is the runtime's with no vendor in it. Everything
# else here needs real provider credentials to get past `session.configured`.
# It lands on port 4900, clear of the template window.
#
# WORKDIR defaults OUTSIDE the repo, and an in-repo one is REFUSED below rather
# than ignored — each scaffolded project installs ~70 MB of node_modules and
# carries .md files `check:markdown` would lint.
#
# Ports are spaced by 10 because a template with a `client.tsx` takes TWO — Vite
# on the declared port and the agent backend on the next free one above it. Both
# answer /health, so this prints the BACKEND port it found: that is the one to
# aim the harnesses at (see `loadtest.mjs` for what the Vite hop costs).
#
# The harnesses, once something is up:
#
#   pnpm loadtest --scenario=http|workflow|session --ports=<name>=<port>
#   pnpm loadtest:probe --port=<port> [--speak]
#   pnpm loadtest:turns --port=4900        # stub agent only
#   pnpm loadtest:platform --slug=<slug> --guest=<origin>
set -uo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CLI="$REPO/packages/aai-cli/cli.ts"
WORKDIR=${WORKDIR:-"$HOME/aai-loadtest"}

# Refused rather than ignored, because ignoring it is not enough to help: a
# scaffolded project carries README.md and system-prompt.md, `check:markdown`
# globs `**/*.md` and does NOT read .gitignore, so a WORKDIR inside the
# worktree fails `pnpm check` on files no one in this repo wrote. That cost a
# blocked push once already.
case "$(cd "$WORKDIR" 2>/dev/null && pwd || echo "$WORKDIR")" in
  "$REPO"|"$REPO"/*)
    echo "WORKDIR must be outside the repo ($REPO) — got $WORKDIR" >&2
    echo "Scaffolded projects carry .md files that \`pnpm check\` would lint." >&2
    exit 2
    ;;
esac
AGENTS=${AGENTS:-"simple research-workflow retail pizza-ordering transcription-workflow"}
PGHOST=${PGHOST:-127.0.0.1}
PGPORT=${PGPORT:-5432}
PGUSER=${PGUSER:-postgres}
PGPASSWORD=${PGPASSWORD:-postgres}
export PGPASSWORD

# `aai dev` authenticates from a config dir and nothing else, so a
# non-interactive run needs one holding a key. ASSEMBLYAI_API_KEY is a separate
# thing — a PROVIDER credential for the agent's own runtime. With a placeholder
# the handshake and every database path are real and only the provider calls 403.
CONFIG_DIR=${AAI_CONFIG_DIR:-"$WORKDIR/.aai-config"}
mkdir -p "$CONFIG_DIR" "$WORKDIR"
[ -f "$CONFIG_DIR/config.json" ] || {
  printf '{"apiKey":"test"}' > "$CONFIG_DIR/config.json"
  chmod 600 "$CONFIG_DIR/config.json"
}
export AAI_CONFIG_DIR="$CONFIG_DIR"
export ASSEMBLYAI_API_KEY=${ASSEMBLYAI_API_KEY:-test}

psql_q() { psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -tAc "$1" "${2:-postgres}"; }

# The session-state tables need no DDL here any more: `aai dev` applies
# `sessionStateDdl` itself at boot, as does the scaffold's `server.mjs`. This
# script used to carry a copy of that DDL, and finding out WHY it had to is what
# fixed the bug — a project with a DATABASE_URL got a boot line reporting
# `sessionState: postgres, durable: true` and then every session died at start,
# the reason (`relation "aai_session_events" does not exist`) appearing only in
# the dev server's log. Creating the database is still ours.

# `stub` replaces the AGENTS list with one project of its own — a different
# measurement rather than a sixth template, so it does not share the window.
if [ "${1:-}" = "stub" ]; then
  AGENTS="stub"
  STUB_PORT=4900
fi

port=4110
for template in $AGENTS; do
  dir="$WORKDIR/$template"
  db="aai_$(echo "$template" | tr -c 'a-z0-9' '_')"

  # The stub agent is `simple` with its sources replaced: `aai init` is what
  # links the workspace SDK and writes the tsconfig, and none of that is worth
  # a second implementation.
  init_template=$template
  [ "$template" = "stub" ] && init_template=simple

  if [ ! -d "$dir" ]; then
    echo "scaffolding $template..."
    ( cd "$WORKDIR" && node "$CLI" init "$template" --template "$init_template" --yes --skipDeploy ) \
      > "$WORKDIR/init-$template.log" 2>&1 || { echo "$template: init FAILED, see $WORKDIR/init-$template.log"; port=$((port+10)); continue; }
  fi

  if [ "$template" = "stub" ]; then
    # Copied on EVERY run, not only the first: these sources are the thing being
    # iterated on, and a stale copy silently benches the previous shape.
    cp "$REPO"/scripts/loadtest-stub-agent/{agent,stubs,host}.ts "$dir/"
    rm -f "$dir/agent.test.ts" "$dir/agent.eval.test.ts" "$dir/system-prompt.md"
    port=${STUB_PORT:-4900}
  fi

  psql_q "select 1 from pg_database where datname='$db'" | grep -q 1 \
    || psql_q "create database $db" > /dev/null
  grep -q '^DATABASE_URL=' "$dir/.env" 2>/dev/null \
    || echo "DATABASE_URL=postgresql://$PGUSER:$PGPASSWORD@$PGHOST:$PGPORT/$db" >> "$dir/.env"

  if [ "$template" = "stub" ]; then
    # `host.ts`, deliberately: a stub registered inside a BUNDLED agent lands in
    # the bundle's own copy of the runtime and the server resolves against
    # another. Its header has the measurement. `node` strips the types.
    ( cd "$dir" && nohup env PORT="$port" DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)" \
        node host.ts > "$WORKDIR/dev-$template.log" 2>&1 & )
  else
    ( cd "$dir" && nohup node "$CLI" dev --port "$port" > "$WORKDIR/dev-$template.log" 2>&1 & )
  fi
  port=$((port+10))
done

echo
echo "waiting for backends (this includes the first bundle + Vite boot)..."
port=${STUB_PORT:-4110}
for template in $AGENTS; do
  found=""
  for _ in $(seq 1 90); do
    # Scan the window this agent owns and take the LAST responder: with a client
    # both Vite and the backend answer, and the backend is the higher port.
    for p in $(seq $((port+4)) -1 "$port"); do
      curl -sf -m 2 "http://localhost:$p/health" 2>/dev/null | grep -q '"status":"ok"' && { found=$p; break; }
    done
    [ -n "$found" ] && break
    sleep 2
  done
  if [ -n "$found" ]; then
    echo "  $template backend=$found $(curl -s -m 2 "http://localhost:$found/health")"
  else
    echo "  $template FAILED — $(tail -2 "$WORKDIR/dev-$template.log" 2>/dev/null | tr '\n' ' ')"
  fi
  port=$((port+10))
done
