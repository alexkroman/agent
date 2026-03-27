// Stub for node:sqlite in browser test environments (jsdom).
// The aai-ui tests never use SQLite directly — this prevents
// Vite from trying to bundle the Node built-in.
export class DatabaseSync {
  constructor() {
    throw new Error("node:sqlite is not available in browser environments");
  }
}
