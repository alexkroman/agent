// Copyright 2026 the AAI authors. MIT license.
// Vite asset imports for the bundled default client. A `.d.ts` is never
// emitted, so this declaration types the side-effect `import "../styles.css"`
// in `default-client.tsx` without reaching the published `dist/` types.

declare module "*.css";
