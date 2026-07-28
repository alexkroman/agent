---
"aai-server": minor
---

The platform server root now serves a browser studio: a TypeScript coding agent (Vercel AI SDK) that edits a server-side workspace and can build and deploy voice agents directly from the browser. Bundling runs in-memory with esbuild; agent config is extracted inside a throwaway sandbox (never on the host) and deployed through the shared deploy core.
