#!/usr/bin/env bash
# Scaffold template agents and run each on its own `aai dev` server, against a
# local Postgres.
#
#   ./scripts/loadtest-boot.sh                       # default template set
#   AGENTS="simple retail" ./scripts/loadtest-boot.sh
#   WORKDIR=/tmp/agents ./scripts/loadtest-boot.sh
#
# WORKDIR defaults OUTSIDE the repo: each scaffolded project installs its own
# node_modules (~70MB each), and putting that in the worktree is what the
# .loadtest/ ignore rule exists to stop happening twice.
#
# Ports are spaced by 10 because a template with a `client.tsx` takes TWO — Vite
# on the declared port and the agent backend on the next free one above it. Both
# answer /health, so this prints the BACKEND port it found: that is the one to
# aim loadtest.mjs at (see its header for what the Vite hop costs).
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

# The session-state tables are NOT created by `aai dev`. `sessionStateDdl` is
# the shape and whoever owns the database applies it — the platform does so when
# provisioning, and locally that is us. Without this every session dies at start
# with a fatal 1011 whose only clue, in the server log, is
# `relation "aai_session_events" does not exist`.
SESSION_DDL='
create table if not exists aai_session_state (
  session_id text not null, slot text not null, value jsonb not null,
  updated_at timestamptz not null default now(), primary key (session_id, slot));
create table if not exists aai_session_events (
  session_id text not null, event_index bigint not null, event jsonb not null,
  created_at timestamptz not null default now(), primary key (session_id, event_index));'

port=4110
for template in $AGENTS; do
  dir="$WORKDIR/$template"
  db="aai_$(echo "$template" | tr -c 'a-z0-9' '_')"

  if [ ! -d "$dir" ]; then
    echo "scaffolding $template..."
    ( cd "$WORKDIR" && node "$CLI" init "$template" --template "$template" --yes --skipDeploy ) \
      > "$WORKDIR/init-$template.log" 2>&1 || { echo "$template: init FAILED, see $WORKDIR/init-$template.log"; port=$((port+10)); continue; }
  fi

  psql_q "select 1 from pg_database where datname='$db'" | grep -q 1 \
    || psql_q "create database $db" > /dev/null
  psql -q -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$db" -c "$SESSION_DDL" > /dev/null
  grep -q '^DATABASE_URL=' "$dir/.env" 2>/dev/null \
    || echo "DATABASE_URL=postgresql://$PGUSER:$PGPASSWORD@$PGHOST:$PGPORT/$db" >> "$dir/.env"

  ( cd "$dir" && nohup node "$CLI" dev --port "$port" > "$WORKDIR/dev-$template.log" 2>&1 & )
  port=$((port+10))
done

echo
echo "waiting for backends (this includes the first bundle + Vite boot)..."
port=4110
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
