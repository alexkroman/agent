import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react({
      // React Fast Refresh makes any module that DECLARES a component a
      // boundary, but can only refresh one whose every EXPORT is a component.
      // A module that is a boundary and cannot be refreshed is the worst case:
      // it gets re-executed, and only then discarded for a page reload. Two
      // kinds of file here are exactly that, and both must be named because
      // passing `exclude` replaces the plugin's default — hence node_modules
      // below, which is that default.
      //
      // `dist/`: a prebuilt dependency. A bundled chunk mixes components with
      // constants, so it can never be a valid boundary. The node_modules
      // default normally hides this, and does NOT when a package is LINKED,
      // because the symlink resolves to a real path outside node_modules.
      // Measured against a linked `@alexkroman1/aai-ui`: one rebuild of it
      // produced 33 partial updates, 12 invalidations and 8 throws of "Session
      // hooks must be used within <SessionProvider>" — a re-executed context
      // module mints a fresh context while the mounted tree holds the old one.
      //
      // `client.tsx`: the entry MOUNTS. Re-executing it is a second
      // `mountClient()` on the same element ("ReactDOMClient.createRoot() on a
      // container that has already been passed to createRoot()"), and since it
      // exports nothing it could never have refreshed anyway. Excluded, an edit
      // to it is one clean page reload — and a component in its OWN file still
      // fast-refreshes, which is the reason to put it there.
      exclude: [/\/node_modules\//, /\/dist\//, /\/client\.tsx$/],
    }),
    tailwindcss(),
  ],
  build: {
    target: "es2022",
    minify: true,
  },
  ssr: {
    noExternal: true,
  },
});
