// Copyright 2025 the AAI authors. MIT license.
// Vite asset imports for the studio client.

declare module "*.css" {
  const css: string;
  export default css;
}

declare module "*.svg" {
  const url: string;
  export default url;
}
