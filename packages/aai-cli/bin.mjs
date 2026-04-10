#!/usr/bin/env node
// Thin wrapper so the bin has a shebang without conflicting with tsdown's banner.
// In dev (pnpm link --global), this imports the TypeScript source directly (Node 24).
await import("./cli.ts");
