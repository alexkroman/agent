// Copyright 2025 the AAI authors. MIT license.
// Studio shell (design 1b): the account-scoped half — routing, the project
// list, the home hero whose first message creates a project, and the account
// menu. Everything that only exists while a project is open lives in
// project-view.tsx, which takes `project` as a REQUIRED prop.
// TanStack Query owns all server state, invalidated after agent turns /
// publishes.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { AccountMenu } from "./account-menu.tsx";
import { api, type ProjectKind, type StudioStatus } from "./api.ts";
import { errorText } from "./api-error.ts";
import { authRejection, useAuthRecovery } from "./auth-recovery.ts";
import { HomeHero, HomeSidebar } from "./home.tsx";
import { useProjectRoute } from "./project-route.ts";
import { ProjectView } from "./project-view.tsx";
import { queryKeys } from "./query-keys.ts";
import { TopBar } from "./top-bar.tsx";
import { type StreamHandlers, useEventStream } from "./use-event-stream.ts";

type AppProps = {
  bearer: string;
  onSignOut: () => void;
  /**
   * Mint a fresh `bearer` after the server rejected the current one — see
   * `useStudioAuth().refresh`. Required rather than optional: an event stream
   * with no way to recover its token retries a dead one forever.
   */
  refreshAuth: () => Promise<void>;
};

export function App({ bearer, onSignOut, refreshAuth }: AppProps) {
  const queryClient = useQueryClient();
  const { project, selectProject } = useProjectRoute();
  // The two top-bar dropdowns overlap in the same corner, so opening one
  // closes the other (the project view closes Publish when it opens this).
  const [accountOpen, setAccountOpen] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);

  const status = useQuery<StudioStatus>({ queryKey: queryKeys.status, queryFn: api.status });

  const projects = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => api.listProjects(bearer),
  });

  // Live project LIST for the home sidebar — a project created or deleted
  // on another device shows up without a refresh.
  useEventStream(
    useCallback(
      (handlers: StreamHandlers) =>
        api.watchProjects(bearer, {
          onData: (names) => queryClient.setQueryData(queryKeys.projects, names),
          ...handlers,
        }),
      [bearer, queryClient],
    ),
    refreshAuth,
  );

  // A stale key is the one auth failure worth handling globally, and the
  // answer is to REFRESH it rather than sign out — see auth-recovery.ts for
  // the session this used to end while it was still recoverable.
  useAuthRecovery(authRejection(projects.error), refreshAuth, { onExhausted: onSignOut });

  // A refreshed bearer has to reach the queries the old one was rejected on:
  // only the account's cache key carries a bearer, so an error-state query has
  // nothing to notice and would stay refused until the next window focus. The
  // brokered chat session is excluded — its token comes from the broker's
  // response, not from this bearer, so re-brokering on every hourly refresh
  // would boot a container for nothing.
  const lastBearer = useRef(bearer);
  useEffect(() => {
    if (lastBearer.current === bearer) return;
    lastBearer.current = bearer;
    void queryClient.invalidateQueries({
      predicate: (query) => query.queryKey[0] !== queryKeys.chatSessions[0],
    });
  }, [bearer, queryClient]);

  // Deliberately no auto-select: landing always shows the hero, and existing
  // projects are one click away in the home sidebar.

  const createProject = useMutation({
    // The SERVER names the project — a base derived from the prompt plus a
    // random suffix, v0-style, via the same generator slugless CLI deploys
    // use (aai-server/slug-generate.ts). The client never mints names.
    //
    // `kind` is the hero's switcher position and is only settable HERE: the
    // server stamps it on the workspace at create time, where it selects the
    // coding agent's system prompt for every later session install.
    mutationFn: ({ prompt, kind }: { prompt: string; kind: ProjectKind }) =>
      api.createProject(bearer, { prompt, kind }),
    onSuccess: (created) => {
      selectProject(created.name);
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
    onError: (err) => {
      setPendingPrompt(null);
      alert(errorText(err));
    },
  });

  // Hero start: typing the first message creates a project (named from the
  // prompt server-side, of the kind the hero's switcher selected) and forwards
  // it as the first chat turn.
  const startWithPrompt = (prompt: string, kind: ProjectKind) => {
    // The hero disables while pending; this guard covers the same-tick
    // race (Enter twice before the re-render) so one prompt never creates
    // two projects.
    if (createProject.isPending) return;
    setPendingPrompt(prompt);
    createProject.mutate({ prompt, kind });
  };

  const toggleAccount = () => setAccountOpen((v) => !v);

  return (
    <div className="relative flex h-full flex-col">
      {project == null ? (
        <>
          {/* The same bar, minus everything project-scoped: the hero has no
              panes and nothing to publish. */}
          <TopBar
            project={null}
            tab="preview"
            hasBuild={false}
            accountOpen={accountOpen}
            onGoHome={() => selectProject(null)}
            onSelectTab={() => undefined}
            onLogOut={onSignOut}
            onTogglePublish={() => undefined}
            onToggleAccount={toggleAccount}
          />
          {/* Home: previous projects in the sidebar, and the stage is one big
              prompt box — typing creates a project and forwards the message as
              its first turn. Landing always starts here (no auto-select). */}
          <div className="flex min-h-0 flex-1">
            <HomeSidebar projects={projects.data} onSelectProject={selectProject} />
            <HomeHero
              status={status.data}
              creating={createProject.isPending}
              onStart={startWithPrompt}
            />
          </div>
        </>
      ) : (
        <ProjectView
          key={project}
          bearer={bearer}
          project={project}
          chatStatus={status.data}
          refreshAuth={refreshAuth}
          initialPrompt={pendingPrompt}
          onInitialPromptSent={() => setPendingPrompt(null)}
          onGoHome={() => selectProject(null)}
          onLogOut={onSignOut}
          accountOpen={accountOpen}
          onToggleAccount={toggleAccount}
        />
      )}
      {/* Account-scoped, so it renders over either half. */}
      <AccountMenu open={accountOpen} bearer={bearer} onClose={() => setAccountOpen(false)} />
    </div>
  );
}
