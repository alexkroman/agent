// Copyright 2026 the AAI authors. MIT license.
/**
 * Named secret storage for the platform.
 *
 * Production secrets live in Supabase Vault (encrypted at rest, decrypted
 * on read through the `vault.decrypted_secrets` view) over the platform's
 * `SUPABASE_DB_URL` connection. Local dev and tests use an in-memory store.
 *
 * Naming convention (helper below):
 * - `agent-env:<slug>` — an agent's env/secret record, JSON-serialized
 *
 * There were TWO. `app-db:<slug>` held an app's provisioned database credentials
 * and nothing writes one now — the platform provisions no databases, and a
 * database an author brings is a value inside their own `agent-env` record like
 * any other secret.
 */

import { sqlState } from "./platform-db-errors.ts";

/**
 * The per-slug secret-name prefix.
 *
 * Exported because it is also spelled in SQL: the orphan-preview sweep
 * (`pg-cron.ts`) deletes `'agent-env:' || slug` from `vault.secrets` inside a
 * plpgsql body, which no type-checker relates to the helper below. Interpolating
 * from here is what keeps the sweep and the writer the same string — a
 * disagreement there deletes nothing, silently, while what it was meant to clean
 * up survives.
 */
export const AGENT_ENV_SECRET_PREFIX = "agent-env:";

/** SecretStore name for one agent's env record. */
export function agentEnvSecretName(slug: string): string {
  return `${AGENT_ENV_SECRET_PREFIX}${slug}`;
}

/**
 * SecretStore name for the platform's own Storage credential.
 *
 * The blob GC sweep runs INSIDE Postgres (pg_cron) and deletes objects through
 * the Storage API with `pg_net`, so it needs a credential that no SQL-only job
 * can otherwise have. Supabase's own guidance for calling an API from pg_cron
 * is exactly this — put the key in Vault and read it in the job body — and the
 * alternative is worse in a way that matters: a key interpolated into the job
 * COMMAND sits in `cron.job` as plaintext, in every operator's listing.
 *
 * The blast radius is not widened by this. The same Vault already holds every
 * tenant's `agent-env:<slug>` — their AssemblyAI keys, and whatever else their
 * agent needs — so anything that can read this can already read strictly more
 * sensitive material. Storage has no narrower credential to use instead.
 */
export const PLATFORM_STORAGE_KEY_SECRET = "platform:storage-key";

/** Minimal SQL executor: one parameterized statement, resolves with rows. */
export type SqlExec = (query: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export type SecretStore = {
  get(name: string): Promise<string | null>;
  put(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
};

/** Postgres `unique_violation` — what a lost create race looks like. */
const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  // Read the SQLSTATE, never the message: a driver rewording "duplicate key
  // value violates unique constraint" would silently turn this retry back
  // into the 500 it exists to prevent.
  return sqlState(err) === UNIQUE_VIOLATION;
}

/**
 * Supabase Vault-backed secret store.
 *
 * - create: `vault.create_secret(value, name)`
 * - read:   `vault.decrypted_secrets` view (decrypts server-side)
 * - update: `vault.update_secret(id, value)` — updating an existing name via
 *   `create_secret` would violate the unique name constraint
 * - delete: plain `delete from vault.secrets`
 */
export function createVaultSecretStore(sql: SqlExec): SecretStore {
  return {
    async get(name) {
      const rows = await sql(
        "select decrypted_secret from vault.decrypted_secrets where name = $1",
        [name],
      );
      const value = rows[0]?.decrypted_secret;
      return typeof value === "string" ? value : null;
    },

    /**
     * Write a secret, creating it or replacing its value.
     *
     * **Idempotent under concurrency, and it has to be.** The natural shape —
     * read the id, then branch to create or update — is a read-then-write
     * with a window in it: two writers of the same name both see no row and
     * both call `create_secret`, so the loser hits the unique-name constraint
     * and the caller gets a 500. Most writes here are safe from that by
     * accident, because every mutation for a slug runs under the per-slug
     * advisory lock — but the ACCOUNT paths take no such lock, and they are
     * exactly the pair that can fire together: `PUT /studio/account/key`
     * (onboarding and rotation) and `POST /studio/cli-link/approve` (which
     * backfills the `key-user:` mapping), plus a double-submitted onboarding
     * form.
     *
     * So the create race is absorbed rather than avoided. One retry is
     * enough by construction: after a unique violation the name exists, so
     * the update branch is the only one left and it cannot lose again.
     */
    async put(name, value) {
      const updateExisting = async (): Promise<boolean> => {
        const existing = await sql("select id from vault.secrets where name = $1", [name]);
        const id = existing[0]?.id;
        if (id === undefined || id === null) return false;
        await sql("select vault.update_secret($1, $2)", [id, value]);
        return true;
      };

      if (await updateExisting()) return;
      try {
        await sql("select vault.create_secret($1, $2)", [value, name]);
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Someone created it between our read and our create. Rethrow if the
        // update still finds nothing — that is a row deleted underneath us,
        // not a race this can settle.
        if (!(await updateExisting())) throw err;
      }
    },

    async delete(name) {
      await sql("delete from vault.secrets where name = $1", [name]);
    },
  };
}

/** In-memory secret store for local dev and tests. */
export function createMemorySecretStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (name) => Promise.resolve(map.get(name) ?? null),
    put: (name, value) => {
      map.set(name, value);
      return Promise.resolve();
    },
    delete: (name) => {
      map.delete(name);
      return Promise.resolve();
    },
  };
}
