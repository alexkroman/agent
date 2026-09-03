// Copyright 2025 the AAI authors. MIT license.
/**
 * Global test setup: isolate the suite from the developer's own machine.
 *
 * Point ALL global-config reads/writes at a per-worker temp dir via the
 * AAI_CONFIG_DIR override in `getConfigDir`. Without this, any test that
 * reaches `approveServer` / `ensureApiKey` without an injected config dir
 * (e.g. through `getServerInfo`) writes to the developer's REAL
 * ~/.config/aai/config.json — permanently approving test origins like
 * https://override.com, which a hostile repo could then use to receive the
 * developer's API key without a prompt.
 *
 * And drop provider credentials from the environment. `resolveServerEnv`
 * layers a project `.env` UNDER the real environment (dotenv does not
 * override what is already set), which is the right precedence for
 * `aai dev` — an explicit shell export should win — but it makes the tests
 * of that function depend on whether the developer happens to have a key
 * exported. One did: `ASSEMBLYAI_API_KEY` in the shell turned a green suite
 * red with the developer's own key in the assertion diff. A test whose
 * result depends on the machine it runs on is not testing the code.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AAI_CONFIG_DIR = mkdtempSync(path.join(os.tmpdir(), "aai-test-config-"));

for (const key of Object.keys(process.env)) {
  if (/^[A-Z0-9_]*API_KEY$/.test(key) || key === "DATABASE_URL") delete process.env[key];
}
