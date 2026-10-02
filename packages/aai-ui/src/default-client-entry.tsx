// Copyright 2026 the AAI authors. MIT license.
/**
 * The prebuilt default client's bundle entry (`index.html` loads it): the
 * stylesheet plus one call. The choice of page lives in `default-client.tsx`,
 * where a spec can drive it without importing a side effect.
 */
// A Vite asset (typed by `vite-env.d.ts`). At the PACKAGE root, not in `src/`: it is a published export
// (`@alexkroman1/aai-ui/styles.css`) and a Vite asset, so it sits beside
// `index.html` and `public/` where the exports map and `files` name it.
import "../styles.css";
import { bootDefaultClient } from "./default-client.tsx";

// `void` rather than a top-level `await`: this is the bundle's entry.
void bootDefaultClient();
