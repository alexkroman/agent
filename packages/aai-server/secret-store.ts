// Copyright 2026 the AAI authors. MIT license.
/**
 * Named secret storage for the platform.
 *
 * Production secrets live in Supabase Vault (encrypted at rest, decrypted
 * on read through the `vault.decrypted_secrets` view) over the platform's
 * `SUPABASE_DB_URL` connection. Local dev and tests use an in-memory store.
 *
 * Naming convention (helpers below):
 * - `agent-env:<slug>` — an agent's env/secret record, JSON-serialized
 * - `app-db:<slug>`    — an app's provisioned database credentials, JSON
 */

/** SecretStore name for one agent's env record. */
export function agentEnvSecretName(slug: string): string {
  return `agent-env:${slug}`;
}

/** SecretStore name for one app's provisioned database credentials. */
export function appDbSecretName(slug: string): string {
  return `app-db:${slug}`;
}

/** Minimal SQL executor: one parameterized statement, resolves with rows. */
export type SqlExec = (query: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export type SecretStore = {
  get(name: string): Promise<string | null>;
  put(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
};

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

    async put(name, value) {
      const existing = await sql("select id from vault.secrets where name = $1", [name]);
      const id = existing[0]?.id;
      if (id !== undefined && id !== null) {
        await sql("select vault.update_secret($1, $2)", [id, value]);
      } else {
        await sql("select vault.create_secret($1, $2)", [value, name]);
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
