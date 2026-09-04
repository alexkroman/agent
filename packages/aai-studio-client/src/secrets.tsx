// Copyright 2026 the AAI authors. MIT license.
// The Secrets pane — the third-party keys this project's agents read as
// `ctx.env`, as a pane of its own beside the chat panel.
//
// It was a card in the Settings pane, wedged between the CLI round-trip and
// Delete project, and its whole UI was one textarea of `KEY=value` lines: to
// attach a single key you typed a shell assignment into a free-text box, and
// the only report that anything had happened was the box emptying. Secrets are
// also the one piece of project configuration a user comes back to — a rotated
// key, a provider added weeks later — which is a poor fit for a page whose
// other half deletes the project.
//
// So the pane splits the two things people actually do. **One key at a time**
// is the primary path: a NAME field and a VALUE field, so the value is typed
// into a password input instead of appearing in plaintext next to its own key,
// and a name that is not a legal environment variable is refused here rather
// than by the server. **Pasting a `.env`** stays available for the bulk case
// (a fresh project, several providers) and keeps the dotenv parse that makes
// multi-line quoted values — PEM keys, service-account JSON — work at all.
//
// Everything else the old card was careful about is carried over: platform-
// managed names are neither listed nor settable, a key the deployed agents do
// not carry yet says so rather than reading as live, and nothing here writes
// into the conversation — each control reports its own outcome (see "No studio
// action writes into the transcript" in the package guide).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, parseSecrets } from "./api.ts";
import { errorText } from "./api-error.ts";
import { PaneShell } from "./pane-shell.tsx";
import { queryKeys } from "./query-keys.ts";
import { isEnterSubmit } from "./send-button.tsx";
import { Card } from "./settings-card.tsx";

/**
 * Secrets the PLATFORM manages, which this pane neither lists, deletes, nor
 * sets. `ASSEMBLYAI_API_KEY` is seeded into every deployed agent at publish
 * from the caller's own account key (aai-cli/deploy.ts) — it is not a
 * third-party key the user attached, and deleting it takes the agent off the
 * air (S2S/STT/TTS connect with an empty bearer and AssemblyAI answers
 * `unauthorized`) with nothing in this pane to put it back. Overriding it
 * with a key for a different account stays a CLI action (`aai secret`, or
 * `.env` + `aai publish`), where it is deliberate rather than a Delete button
 * one row away from a third-party key.
 */
const PLATFORM_MANAGED_SECRETS: readonly string[] = ["ASSEMBLYAI_API_KEY"];

/**
 * What a POSIX environment variable name may look like, which is what these
 * become inside the guest. Checked HERE because the failure is otherwise a
 * round trip to learn that `my key` was never going to work — and because a
 * name with an `=` in it is a typo in the one-field-per-value form, where the
 * .env path would have read it as part of the value.
 */
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The name field, normalized the way a shell would see it. */
function normalizeName(raw: string): string {
  return raw.trim();
}

/**
 * Split parsed entries into the ones this pane may save and the managed names
 * it must refuse. A managed key typed into either form would save and then not
 * appear in the list below, which reads as a failed write — so it is refused by
 * name and said so.
 */
function splitManaged(parsed: Record<string, string>): {
  updates: Record<string, string>;
  managed: string[];
} {
  const managed = Object.keys(parsed).filter((name) => PLATFORM_MANAGED_SECRETS.includes(name));
  const updates = Object.fromEntries(
    Object.entries(parsed).filter(([name]) => !managed.includes(name)),
  );
  return { updates, managed };
}

/** The sentence a refusal renders as, so both forms word it identically. */
function managedRefusal(managed: string[]): string {
  return `${managed.join(", ")} ${managed.length > 1 ? "are" : "is"} managed for you and can't be set here.`;
}

/**
 * The PUT both forms go through. Two instances rather than one shared
 * mutation: `isPending` and `error` are read next to the button that fired
 * them, so a single mutation would put "Saving…" on the .env button while a
 * one-key add was in flight, and a failed paste would print its error under
 * the add form too.
 *
 * `onSaved` runs only on success, which is what keeps a failed save's input
 * on screen — the draft is what the user would otherwise have to retype.
 */
function useSaveSecrets(bearer: string, project: string, onSaved: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (updates: Record<string, string>) => api.putSecrets(bearer, project, updates),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.secrets(project) });
      onSaved();
    },
  });
}

type SecretsPaneProps = {
  bearer: string;
  /** The open project. Secrets are keyed by project, never by slug. */
  project: string;
};

/**
 * No slug of any kind, and no publish-first gate: the server holds the
 * project's own copy of the set and reconciles it into each agent as that
 * agent's deploy claims a slug (`aai-studio-server/studio-secrets.ts`). An
 * agent needs its provider key to run at all, so requiring a publish first
 * would ask for the one order that cannot work — ship it broken, attach the
 * key, ship again.
 */
export function SecretsPane({ bearer, project }: SecretsPaneProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [bulk, setBulk] = useState("");
  // A refusal per FORM, for the same reason there are two mutations: each is
  // rendered under the control that produced it, and a paste naming a managed
  // key must not print its reason under the Add card.
  const [addRefusal, setAddRefusal] = useState<string | null>(null);
  const [pasteRefusal, setPasteRefusal] = useState<string | null>(null);

  const secrets = useQuery({
    queryKey: queryKeys.secrets(project),
    queryFn: () => api.listSecrets(bearer, project),
  });

  const add = useSaveSecrets(bearer, project, () => {
    setName("");
    setValue("");
  });
  const paste = useSaveSecrets(bearer, project, () => setBulk(""));

  const remove = useMutation({
    mutationFn: (secret: string) => api.deleteSecret(bearer, project, secret),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.secrets(project) });
    },
  });

  const submitOne = () => {
    const key = normalizeName(name);
    if (key === "" || value === "" || add.isPending) return;
    if (!VALID_NAME.test(key)) {
      setAddRefusal(
        `"${key}" isn't a valid environment variable name — letters, digits and _ only.`,
      );
      return;
    }
    const { updates, managed } = splitManaged({ [key]: value });
    if (managed.length > 0) {
      setAddRefusal(managedRefusal(managed));
      return;
    }
    setAddRefusal(null);
    add.mutate(updates);
  };

  const submitBulk = () => {
    const { updates, managed } = splitManaged(parseSecrets(bulk));
    setPasteRefusal(managed.length > 0 ? managedRefusal(managed) : null);
    if (Object.keys(updates).length === 0 || paste.isPending) return;
    paste.mutate(updates);
  };

  const onDelete = (secret: string) => {
    if (remove.isPending) return;
    if (!window.confirm(`Delete ${secret}? Agents reading it will stop finding it.`)) return;
    remove.mutate(secret);
  };

  // Platform-managed keys are filtered out of the list, which is also what
  // withholds their Delete button — there is no row to hang one on.
  const names = (secrets.data?.vars ?? []).filter(
    (secret) => !PLATFORM_MANAGED_SECRETS.includes(secret),
  );
  const pending = secrets.data?.pending ?? [];
  const listError = errorText(secrets.error ?? remove.error);

  return (
    <PaneShell
      title="Secrets"
      subtitle={
        <>
          Provider keys for <span className="font-mono text-fg">{project}</span>, readable in your
          tools as <code className="font-mono">ctx.env</code>
        </>
      }
    >
      <Card
        title="Add a secret"
        blurb={
          <>
            The name is what your code reads (
            <code className="font-mono">ctx.env.OPENAI_API_KEY</code>
            ); the value is write-only — it is never sent back to this page. Keys reach both the
            preview and production agents: the preview redeploys with them right away, production
            when you publish. <code className="font-mono">ASSEMBLYAI_API_KEY</code> is set and
            managed for you.
          </>
        }
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <label className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="text-[11px] tracking-[0.6px] text-muted uppercase">Name</span>
            <input
              className="field h-10 font-mono text-xs"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setAddRefusal(null);
              }}
              onKeyDown={(e) => {
                if (isEnterSubmit(e)) submitOne();
              }}
              placeholder="OPENAI_API_KEY"
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="text-[11px] tracking-[0.6px] text-muted uppercase">Value</span>
            <input
              className="field h-10 font-mono text-xs"
              type="password"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setAddRefusal(null);
              }}
              onKeyDown={(e) => {
                if (isEnterSubmit(e)) submitOne();
              }}
              placeholder="sk-…"
              spellCheck={false}
              autoComplete="off"
            />
          </label>
        </div>
        <button
          type="button"
          className="btn btn-primary self-start"
          onClick={submitOne}
          disabled={add.isPending || normalizeName(name) === "" || value === ""}
        >
          {add.isPending ? "Saving…" : "Add secret"}
        </button>
        {addRefusal && <p className="m-0 text-xs text-err">{addRefusal}</p>}
        {errorText(add.error) && <p className="m-0 text-xs text-err">{errorText(add.error)}</p>}
      </Card>

      <Card
        title={names.length > 0 ? `Attached keys · ${names.length}` : "Attached keys"}
        blurb="What this project holds. Values can't be read back — a key you need to change is one you re-add, which overwrites it."
      >
        {names.length > 0 ? (
          <ul className="m-0 flex list-none flex-col overflow-hidden rounded-md border border-line p-0">
            {names.map((secret) => (
              <li
                key={secret}
                className="flex items-center gap-3 border-b border-line bg-cream px-3 py-2 last:border-b-0"
              >
                <code className="min-w-0 flex-1 truncate font-mono text-xs">{secret}</code>
                {/* Saved, but not on every agent yet — the honest state for a
                    project that hasn't published, and the one a bare list
                    would misreport as live everywhere. */}
                <span
                  className={
                    pending.includes(secret) ? "text-[11px] text-muted" : "text-[11px] text-subtle"
                  }
                >
                  {pending.includes(secret) ? "on next deploy" : "live"}
                </span>
                <span className="font-mono text-[11px] text-subtle" aria-hidden>
                  ••••••••
                </span>
                <button
                  type="button"
                  className="btn px-2 py-1 text-xs"
                  onClick={() => onDelete(secret)}
                  disabled={remove.isPending}
                >
                  {remove.isPending && remove.variables === secret ? "Deleting…" : "Delete"}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          // Distinguishes "nothing attached" from "we haven't asked yet": a
          // failed listing renders its error below instead of this line.
          !(secrets.isLoading || secrets.isError) && (
            <p className="m-0 text-[13px] text-muted">
              No secrets yet. Anything your tools call with a key — a model provider, a CRM, your
              own API — goes here.
            </p>
          )
        )}
        {listError && <p className="m-0 text-xs text-err">{listError}</p>}
      </Card>

      <Card
        title="Paste a .env"
        blurb={
          <>
            For several keys at once. One <code className="font-mono">KEY=value</code> per line,
            real <code className="font-mono">.env</code> syntax — quoted multi-line values (PEM
            keys, service-account JSON) included.
          </>
        }
      >
        <textarea
          className="field h-28 resize-y py-2 font-mono text-xs"
          value={bulk}
          onChange={(e) => {
            setBulk(e.target.value);
            setPasteRefusal(null);
          }}
          placeholder="OPENAI_API_KEY=..."
          spellCheck={false}
        />
        <button
          type="button"
          className="btn self-start"
          onClick={submitBulk}
          disabled={paste.isPending}
        >
          {paste.isPending ? "Saving…" : "Save secrets"}
        </button>
        {pasteRefusal && <p className="m-0 text-xs text-err">{pasteRefusal}</p>}
        {errorText(paste.error) && <p className="m-0 text-xs text-err">{errorText(paste.error)}</p>}
      </Card>
    </PaneShell>
  );
}
