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

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api.ts";
import { ApiKeyField } from "./api-key-field.tsx";
import { DropdownPanel } from "./dropdown-panel.tsx";
import { queryKeys } from "./query-keys.ts";

/** Links the top bar's toggle to this panel, and exempts it from click-away. */
export const ACCOUNT_MENU_ID = "account-menu";
export const ACCOUNT_TOGGLE_ATTR = "data-account-toggle";

type AccountMenuProps = {
  open: boolean;
  bearer: string;
  onClose: () => void;
};

export function AccountMenu({ open, bearer, onClose }: AccountMenuProps) {
  const queryClient = useQueryClient();

  // Shares main.tsx's cache entry (same key), so the email is already there
  // on first open; `enabled` keeps a closed menu off the network entirely.
  const account = useQuery({
    queryKey: queryKeys.account(bearer),
    queryFn: () => api.getAccount(bearer),
    enabled: open,
  });

  return (
    <DropdownPanel
      id={ACCOUNT_MENU_ID}
      label="Account"
      open={open}
      onClose={onClose}
      toggleAttr={ACCOUNT_TOGGLE_ATTR}
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
      <ApiKeyField
        bearer={bearer}
        submitLabel="Update key"
        inputClassName="h-9"
        ariaLabel="New AssemblyAI API key"
        placeholder={account.data?.hasKey ? "New key (current: ••••••••)" : "AssemblyAI API key"}
        onSaved={() => {
          // A project's coding-agent sandbox was installed with the OLD key
          // (`studio/session-init` delivers the caller's key to the guest, and
          // every chat turn dials the LLM gateway with it). Dropping the
          // brokered session makes the next one re-install with the new key —
          // the broker re-inits the SAME live sandbox, so this costs one
          // request, not a respawn, and the chat URL and token are unchanged.
          void queryClient.invalidateQueries({ queryKey: queryKeys.chatSessions });
        }}
        savedNote={
          <p className="m-0 text-xs text-muted">
            Key updated. New chat turns and publishes use it right away.
          </p>
        }
      />
    </DropdownPanel>
  );
}
