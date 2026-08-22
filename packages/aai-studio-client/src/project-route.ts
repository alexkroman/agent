// Copyright 2026 the AAI authors. MIT license.
/**
 * v0-style project URLs: each project lives at `/studio/chat/<name>`, so a
 * build is linkable and bookmarkable. The server serves the same shell for any
 * such path; the client owns the mapping, with `pushState` on selection and
 * `popstate` for Back/Forward.
 */

import { VALID_SLUG_RE } from "@alexkroman1/aai/internal";
import { useEffect, useState } from "react";

const PROJECT_PATH_RE = /^\/studio\/chat\/([a-z0-9][a-z0-9_-]*)\/?$/;

/**
 * The PUBLIC API page's path — one deployed agent's documentation, at a URL
 * that needs no session (`/studio/api/<slug>`).
 *
 * Under `/studio` rather than at a namespace of its own because that prefix is
 * already a RESERVED_SLUG (aai/sdk/slug.ts) and already dispatched to the
 * studio app (`isStudioPath`), so no agent can ever shadow this path and no
 * new reservation is owed. It names a SLUG, not a project: the page documents
 * what a deployed agent answers, which is all an anonymous reader can be shown
 * and all this page needs — a project name would be an account-scoped handle on
 * a page with no account behind it.
 *
 * The slug pattern is the SDK's own rather than a second spelling of it, so a
 * link the studio builds cannot fail to parse here.
 */
const API_DOCS_PATH_RE = new RegExp(`^/studio/api/(${VALID_SLUG_RE.source.slice(1, -1)})/?$`);

/** The agent a public API-page URL names, or `null` when it is not one. */
export function apiDocsSlugFromPath(pathname: string): string | null {
  return API_DOCS_PATH_RE.exec(pathname)?.[1] ?? null;
}

/** Where one agent's public API page lives. */
export function apiDocsPath(slug: string): string {
  return `/studio/api/${encodeURIComponent(slug)}`;
}

/** The project a studio URL names, or `null` for the home hero. */
export function projectFromPath(pathname: string): string | null {
  return PROJECT_PATH_RE.exec(pathname)?.[1] ?? null;
}

/** The URL a selection should put in the address bar. */
export function projectPath(name: string | null): string {
  return name ? `/studio/chat/${encodeURIComponent(name)}` : "/";
}

export type ProjectRoute = {
  /** The open project, or `null` on the home hero. */
  project: string | null;
  /** Select a project (or `null` for home) and sync the URL. */
  selectProject: (name: string | null) => void;
};

export function useProjectRoute(): ProjectRoute {
  // The URL seeds the initial selection (a shared /studio/chat/<name> link
  // opens that project); after that, selection drives the URL.
  const [project, setProject] = useState<string | null>(() =>
    projectFromPath(window.location.pathname),
  );

  // Back/forward moves between home and projects like any other pages.
  useEffect(() => {
    const onPop = () => setProject(projectFromPath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  return {
    project,
    selectProject: (name) => {
      setProject(name);
      const path = projectPath(name);
      if (window.location.pathname !== path) window.history.pushState(null, "", path);
    },
  };
}
