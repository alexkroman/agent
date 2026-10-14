// Copyright 2026 the AAI authors. MIT license.
/**
 * v0-style project URLs: each project lives at `/studio/chat/<name>`, so a
 * build is linkable and bookmarkable. The server serves the same shell for any
 * such path; the client owns the mapping, with `pushState` on selection and
 * `popstate` for Back/Forward.
 */

import { useEffect, useState } from "react";

const PROJECT_PATH_RE = /^\/studio\/chat\/([a-z0-9][a-z0-9_-]*)\/?$/;

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
