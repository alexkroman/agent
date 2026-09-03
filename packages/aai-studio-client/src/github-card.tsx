// Copyright 2026 the AAI authors. MIT license.
// The "Sync to GitHub" card on the Settings pane: connect the account's GitHub
// App installation, pick a repository, push the project's files there as one
// commit.
//
// Three states, and which one renders is decided by the SERVER rather than by
// anything this component can guess:
//
// - **Not configured** — the platform has no GitHub App (a self-hosted deploy,
//   local dev). The card renders NOTHING. An explanatory card would be a
//   permanent row about a feature the reader cannot obtain.
// - **Not connected** — this account has not installed the App. One button,
//   which sends the tab to GitHub; the return trip lands back on this project
//   with `?github=` (github-result.ts).
// - **Connected** — the repository picker and Sync.
//
// The last two are COMPONENTS rather than branches, and that is not only the
// complexity threshold talking: each owns mutations the other never fires, so
// as branches of one function every `isPending` and `error` in the file was in
// scope for markup that could not have produced it.
//
// Like every other pane it reports its own outcome beside the control that did
// it and writes NOTHING into the conversation (see "No studio action writes
// into the transcript" in the package guide).

import { type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, type GithubRepo, type GithubStatus, type GithubSyncResult } from "./api.ts";
import { errorText } from "./api-error.ts";
import {
  consumeGithubResult,
  type GithubConnectResult,
  githubResultText,
} from "./github-result.ts";
import { queryKeys } from "./query-keys.ts";
import { Card } from "./settings-card.tsx";

/**
 * The workspace stamps this card reads — a narrow slice of `ProjectData`.
 *
 * Named rather than taking the whole payload, so `SettingsPane` does not
 * become the place future cards reach for arbitrary project state and a field
 * added to `ProjectData` does not re-type a pane that wants a repo name and
 * two flags.
 */
export type GithubSyncState = {
  githubRepo?: string | undefined;
  githubCommit?: string | undefined;
  githubStale?: boolean | undefined;
};

/**
 * What the card says about the last sync, given the workspace's own stamps.
 *
 * Pure and exported, because the three states are the whole point of the card
 * and each is one word away from another: never synced, current, behind.
 * `githubStale` is computed server-side against the same `filesHash` the
 * deploy staleness uses — the client never hashes files.
 */
export function syncStateText(data: GithubSyncState | undefined): string | null {
  if (!data?.githubRepo) return null;
  if (data.githubStale) return "This project has edits GitHub does not have yet.";
  return "GitHub is up to date with this project.";
}

/**
 * The commit URL for a workspace's LAST sync, or null.
 *
 * This is what makes `githubCommit` a stamp anything reads: the sync response
 * carries a commit link, but only until the page reloads, and "where did this
 * project last go" is exactly the question a reader has on a cold open.
 */
export function lastCommitUrl(data: GithubSyncState | undefined): string | null {
  if (!(data?.githubRepo && data.githubCommit)) return null;
  return `https://github.com/${data.githubRepo}/commit/${data.githubCommit}`;
}

/** One muted line — the shape every report in this card takes. */
function Note({ children, error = false }: { children: React.ReactNode; error?: boolean }) {
  return <p className={`m-0 text-[13px] ${error ? "text-err" : "text-muted"}`}>{children}</p>;
}

/** Not connected: the one button that starts the authorize round trip. */
function ConnectPrompt({ bearer, project }: { bearer: string; project: string }) {
  const connect = useMutation({
    mutationFn: () => api.githubConnect(bearer, project),
    onSuccess: ({ installUrl }) => {
      // A full navigation, not a popup. The round trip ends in a redirect
      // back to this project with `?github=`, which reloads the page and so
      // re-reads the status below — there is nothing for a popup to report
      // that the reload does not already carry.
      //
      // A popup was proposed when this flow appeared to hang: connecting
      // worked on GitHub's side and the button never became Sync. The cause
      // was on the SERVER — the URL used to be the App's install page, which
      // GitHub does not redirect back from once the App is installed, so the
      // callback never ran (`githubAuthorizeUrl` in
      // aai-studio-server/studio-github-config.ts). A popup would have made
      // that worse rather than better: it would have sat on a GitHub settings
      // page with nothing to post back and no reload to recover through.
      window.location.href = installUrl;
    },
  });
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        className="btn self-start"
        onClick={() => connect.mutate()}
        disabled={connect.isPending}
      >
        {connect.isPending ? "Opening GitHub…" : "Connect GitHub"}
      </button>
      {connect.error && <Note error>{errorText(connect.error)}</Note>}
    </div>
  );
}

/**
 * Create a repository, for an ORGANIZATION installation only.
 *
 * Its own component so it can be absent rather than disabled: for a personal
 * account GitHub does not permit this at all (`POST /user/repos` is closed to
 * installation tokens), so a greyed-out field would promise something no
 * permission grant can unlock. The card points at GitHub for that case.
 */
function CreateRepo({
  bearer,
  onCreated,
}: {
  bearer: string;
  onCreated: (fullName: string) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");

  const create = useMutation({
    mutationFn: () => api.githubCreateRepo(bearer, name.trim()),
    onSuccess: (repo) => {
      setName("");
      // Select it immediately: the user named it in order to push to it.
      onCreated(repo.fullName);
      void queryClient.invalidateQueries({ queryKey: queryKeys.githubRepos(bearer) });
    },
  });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end gap-2">
        <label className="flex flex-col gap-1 text-[13px]">
          <span className="text-muted">Or create a new one</span>
          <input
            className="input max-w-xs"
            placeholder="repository-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={create.isPending}
          />
        </label>
        <button
          type="button"
          className="btn"
          onClick={() => create.mutate()}
          disabled={name.trim() === "" || create.isPending}
        >
          {create.isPending ? "Creating…" : "Create"}
        </button>
      </div>
      {create.error && <Note error>{errorText(create.error)}</Note>}
    </div>
  );
}

/**
 * The repository `<select>` and the two things it has to be able to say:
 * still loading, and "the App cannot write anywhere yet".
 *
 * Its own component to keep `SyncControls` under the complexity threshold —
 * and the seam is a real one, since nothing here fires a mutation. It takes
 * the QUERY rather than its data so it can tell "loading" from "empty", which
 * are the two states a bare array cannot distinguish and which call for
 * opposite things from the reader.
 */
function RepoPicker({
  repos,
  value,
  onChange,
  disabled,
}: {
  repos: UseQueryResult<readonly GithubRepo[]>;
  value: string;
  onChange: (fullName: string) => void;
  disabled: boolean;
}) {
  return (
    <>
      <label className="flex flex-col gap-1 text-[13px]">
        <span className="text-muted">Repository</span>
        <select
          className="input max-w-md"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={repos.isPending || disabled}
        >
          <option value="">
            {repos.isPending ? "Loading repositories…" : "Choose a repository…"}
          </option>
          {(repos.data ?? []).map((entry) => (
            <option key={entry.fullName} value={entry.fullName}>
              {entry.fullName}
              {entry.private ? " (private)" : ""}
            </option>
          ))}
        </select>
      </label>

      {/* The empty picker is the state a user is most likely to be stuck in,
          and the fix is on GitHub rather than here — so it names it rather
          than reading as a loading list that never finished. */}
      {repos.data?.length === 0 && (
        <Note>
          The AAI app cannot write to any repository yet. Add one from the link above — create it on
          GitHub first if it does not exist.
        </Note>
      )}
      {repos.error && <Note error>{errorText(repos.error)}</Note>}
    </>
  );
}

/** Connected: pick a repository, push, or disconnect. */
function SyncControls({
  bearer,
  project,
  data,
  status,
  onDisconnected,
}: {
  bearer: string;
  project: string;
  data: GithubSyncState | undefined;
  status: GithubStatus;
  onDisconnected: () => void;
}) {
  const queryClient = useQueryClient();
  const [repo, setRepo] = useState(data?.githubRepo ?? "");

  // Read once per pane open, like every other query in this client. The
  // defaults (`staleTime: 0`, `refetchOnWindowFocus: true`) would re-run this
  // on every window focus, and each run costs a fresh Supabase Auth round trip
  // (`requireStudioUser`), a secret read, an installation-token exchange and a
  // GitHub listing. The mutations below invalidate the key when it moves.
  const repos = useQuery({
    queryKey: queryKeys.githubRepos(bearer),
    queryFn: () => api.githubRepos(bearer),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });

  // Default the picker to wherever this project last synced, so the common
  // case — press Sync again after an edit — needs no selection at all. An
  // effect as well as the initial state, because the workspace read can land
  // after this mounts (the pane renders while it is in flight).
  //
  // It only ever fills an EMPTY picker. Without that guard a repository chosen
  // while the project query was still in flight is silently replaced when that
  // read lands, and the next Sync pushes somewhere the user did not pick — the
  // one wrong outcome this card must not have.
  useEffect(() => {
    if (data?.githubRepo) setRepo((current) => current || data.githubRepo || "");
  }, [data?.githubRepo]);

  const disconnect = useMutation({
    mutationFn: () => api.githubDisconnect(bearer),
    onSuccess: () => {
      onDisconnected();
      void queryClient.invalidateQueries({ queryKey: queryKeys.github(bearer) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.githubRepos(bearer) });
    },
  });

  const sync = useMutation<GithubSyncResult>({
    mutationFn: () => api.syncToGithub(bearer, project, repo),
    // The workspace's github stamps moved, and the staleness line reads off them.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.project(project) });
    },
  });

  const state = syncStateText(data);
  const lastSync = lastCommitUrl(data);
  return (
    <div className="flex flex-col gap-4">
      <Note>
        Connected as <span className="font-mono text-fg">{status.account}</span>.{" "}
        {status.manageUrl && (
          <a href={status.manageUrl} target="_blank" rel="noreferrer" className="underline">
            Add or remove repositories
          </a>
        )}
      </Note>

      <RepoPicker repos={repos} value={repo} onChange={setRepo} disabled={sync.isPending} />

      {status.accountType === "Organization" && <CreateRepo bearer={bearer} onCreated={setRepo} />}

      <div className="flex items-center gap-3">
        <button
          type="button"
          className="btn self-start"
          onClick={() => sync.mutate()}
          disabled={repo === "" || sync.isPending}
        >
          {sync.isPending ? "Syncing…" : "Sync to GitHub"}
        </button>
        <button
          type="button"
          className="btn self-start text-muted"
          onClick={() => {
            // Asked, because disconnecting is invisible until the next sync
            // fails — the button sits beside the one people mean to press.
            if (window.confirm("Disconnect GitHub from this account?")) disconnect.mutate();
          }}
          disabled={disconnect.isPending}
        >
          Disconnect
        </button>
      </div>

      {/* The sync's own answer wins over the workspace's staleness line: it is
          newer, and it distinguishes the no-op ("already up to date") from a
          push, which the stamps alone cannot. */}
      {sync.data ? (
        <Note>
          {sync.data.changed ? "Pushed to " : "Already up to date on "}
          <span className="font-mono text-fg">
            {sync.data.repo}@{sync.data.branch}
          </span>
          .{" "}
          <a href={sync.data.commitUrl} target="_blank" rel="noreferrer" className="underline">
            View commit
          </a>
        </Note>
      ) : (
        state && (
          <Note>
            {state}{" "}
            {lastSync && (
              <a href={lastSync} target="_blank" rel="noreferrer" className="underline">
                View last commit
              </a>
            )}
          </Note>
        )
      )}
      {sync.error && <Note error>{errorText(sync.error)}</Note>}
      {disconnect.error && <Note error>{errorText(disconnect.error)}</Note>}
    </div>
  );
}

const CONNECTED_BLURB =
  "Pushes this project's files to a repository as one commit. One-way: the commit replaces the " +
  "branch's tree, so a file deleted here is deleted there.";
const DISCONNECTED_BLURB =
  "Connect a GitHub account to push this project's files to a repository. You choose which " +
  "repositories the AAI app can write to.";

export function GithubCard({
  bearer,
  project,
  data,
}: {
  bearer: string;
  project: string;
  /** The workspace stamps — the last sync's target, commit and staleness. */
  data: GithubSyncState | undefined;
}) {
  /** The round-trip report from the install callback, shown once. */
  const [connectResult, setConnectResult] = useState<GithubConnectResult | null>(null);

  // Same as the repository listing below it — see there for what a refetch
  // costs. `api.githubStatus` documents itself as read once per pane open,
  // which is only true with these two options set.
  const status = useQuery({
    queryKey: queryKeys.github(bearer),
    queryFn: () => api.githubStatus(bearer),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });

  // The install round trip reports through the URL, so it is read once on
  // mount and stripped. Empty deps: a re-render must not re-announce it, and
  // the parameter is gone after the first read anyway.
  useEffect(() => {
    const result = consumeGithubResult();
    if (result) setConnectResult(result);
  }, []);

  // Nothing to offer: this deployment has no GitHub App. Held back until the
  // status has actually answered, so the card does not appear and then vanish.
  if (status.isPending || status.data?.configured !== true) return null;
  const github = status.data;

  return (
    <Card title="Sync to GitHub" blurb={github.connected ? CONNECTED_BLURB : DISCONNECTED_BLURB}>
      {connectResult && <Note>{githubResultText(connectResult)}</Note>}
      {github.connected ? (
        <SyncControls
          bearer={bearer}
          project={project}
          data={data}
          status={github}
          onDisconnected={() => setConnectResult(null)}
        />
      ) : (
        <ConnectPrompt bearer={bearer} project={project} />
      )}
    </Card>
  );
}
