// Copyright 2026 the AAI authors. MIT license.
// The Account dropdown: who you're signed in as, and the one control for
// replacing this account's stored AssemblyAI API key.
//
// It hangs off the top bar rather than the Settings pane because the key is
// ACCOUNT-scoped, not project-scoped — it has to be reachable from the home
// screen, where no project (and so no Settings pane) exists. Before this the
// key could only be set once, on the onboarding gate after sign-in
// (main.tsx's KeyGate), and a rotated or wrong key left the studio with no
// way back short of signing up again.
//
// The browser never reads the key back: `GET /studio/account` reports only
// whether one is stored (`hasKey`), so this is a write-only field — the
// stored value is shown as a masked placeholder, never fetched.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { api } from "./api.ts";
import { errorText } from "./api-error.ts";
import { useDismissablePanel } from "./dismissable.ts";
import { queryKeys } from "./query-keys.ts";
import { isEnterSubmit } from "./send-button.tsx";

/** Links the top bar's toggle to this panel, and exempts it from click-away. */
export const ACCOUNT_MENU_ID = "account-menu";
export const ACCOUNT_TOGGLE_ATTR = "data-account-toggle";

type AccountMenuProps = {
  open: boolean;
  bearer: string;
  onClose: () => void;
};

export function AccountMenu({ open, bearer, onClose }: AccountMenuProps) {
  const panel = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  useDismissablePanel({ open, onClose, panel, toggleAttr: ACCOUNT_TOGGLE_ATTR });

  // Shares main.tsx's cache entry (same key), so the email is already there
  // on first open; `enabled` keeps a closed menu off the network entirely.
  const account = useQuery({
    queryKey: queryKeys.account(bearer),
    queryFn: () => api.getAccount(bearer),
    enabled: open,
  });

  const save = useMutation({
    mutationFn: (apiKey: string) => api.putAccountKey(bearer, apiKey),
    onSuccess: () => {
      setDraft("");
      void queryClient.invalidateQueries({ queryKey: queryKeys.accounts });
      // A project's coding-agent sandbox was installed with the OLD key
      // (`studio/session-init` delivers the caller's key to the guest, and
      // every chat turn dials the LLM gateway with it). Dropping the brokered
      // session makes the next one re-install with the new key — the broker
      // re-inits the SAME live sandbox, so this costs one request, not a
      // respawn, and the chat URL and token are unchanged.
      void queryClient.invalidateQueries({ queryKey: queryKeys.chatSessions });
    },
  });

  if (!open) return null;

  const submit = () => {
    const apiKey = draft.trim();
    if (!apiKey || save.isPending) return;
    save.mutate(apiKey);
  };

  const error = errorText(save.error);
  return (
    <div
      ref={panel}
      id={ACCOUNT_MENU_ID}
      role="dialog"
      aria-label="Account"
      className="absolute top-14 right-5 z-10 flex w-96 flex-col gap-3 rounded-lg border border-line bg-panel p-5 shadow-md"
    >
      {account.data?.email && (
        <p className="m-0 truncate text-[13px] text-fg" title={account.data.email}>
          Signed in as <span className="font-mono">{account.data.email}</span>
        </p>
      )}
      <p className="m-0 text-[13px] leading-5 text-muted">
        Everything here runs on your own AssemblyAI API key — chat turns, previews, and the agents
        you publish. Paste a new one to replace the stored key; it is also the key{" "}
        <code className="font-mono">aai login</code> hands to your terminal. Get one from{" "}
        <a
          href="https://www.assemblyai.com/dashboard"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          your dashboard
        </a>
        .
      </p>
      <input
        className="field h-9"
        type="password"
        aria-label="New AssemblyAI API key"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (isEnterSubmit(e)) submit();
        }}
        placeholder={account.data?.hasKey ? "New key (current: ••••••••)" : "AssemblyAI API key"}
        spellCheck={false}
        autoComplete="off"
      />
      <button
        type="button"
        className="btn btn-primary self-start"
        onClick={submit}
        disabled={save.isPending || draft.trim() === ""}
      >
        {save.isPending ? "Saving…" : "Update key"}
      </button>
      {/* Cleared on the next edit, so it can't linger over a stale field. */}
      {save.isSuccess && draft === "" && (
        <p className="m-0 text-xs text-muted">
          Key updated. New chat turns and publishes use it right away.
        </p>
      )}
      {error && <p className="m-0 text-xs text-err">{error}</p>}
    </div>
  );
}
