// Copyright 2025 the AAI authors. MIT license.
/**
 * Global test setup: point ALL global-config reads/writes at a per-worker
 * temp dir via the AAI_CONFIG_DIR override in `getConfigDir`.
 *
 * Without this, any test that reaches `approveServer` / `ensureApiKey`
 * without an injected config dir (e.g. through `getServerInfo`) writes to
 * the developer's REAL ~/.config/aai/config.json — permanently approving
 * test origins like https://override.com, which a hostile repo could then
 * use to receive the developer's API key without a prompt.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AAI_CONFIG_DIR = mkdtempSync(path.join(os.tmpdir(), "aai-test-config-"));
