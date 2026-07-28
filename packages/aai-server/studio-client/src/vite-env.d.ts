// Copyright 2025 the AAI authors. MIT license.
// Vite side-effect asset imports (CSS) for the studio client.

declare module "*.css" {
  const css: string;
  export default css;
}
