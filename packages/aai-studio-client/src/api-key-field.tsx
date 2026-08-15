// Copyright 2026 the AAI authors. MIT license.
/**
 * The one control that stores an AssemblyAI API key against the account.
 *
 * There were two of them — the onboarding gate after sign-in and the account
 * menu's rotate-the-key field — over the SAME endpoint, each with its own
 * hand-rolled `draft`/`busy`/`error` triple and its own submit. Two copies of a
 * form whose whole job is to not lose a credential is two chances to disagree
 * about when the field clears, which is exactly what happened (the gate cleared
 * nothing on failure; the menu cleared the draft on success and used that as
 * its "saved" signal).
 *
 * `useMutation`, like the rest of the package, so `isPending` and `error` come
 * from the request rather than from state a handler has to remember to unset.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./api.ts";
import { errorText } from "./api-error.ts";
import { queryKeys } from "./query-keys.ts";
import { isEnterSubmit } from "./send-button.tsx";

type ApiKeyFieldProps = {
  bearer: string;
  /** Submit-button label when idle. The two callers frame the step differently. */
  submitLabel: string;
  placeholder: string;
  /** Height class for the input — the gate is roomier than the dropdown. */
  inputClassName?: string;
  ariaLabel?: string;
  /** Ran after a successful store, once the account query has been invalidated. */
  onSaved?: (() => void) | undefined;
  /** Rendered under the button after a save, while the field is still empty. */
  savedNote?: React.ReactNode;
};

export function ApiKeyField({
  bearer,
  submitLabel,
  placeholder,
  inputClassName = "h-10",
  ariaLabel,
  onSaved,
  savedNote,
}: ApiKeyFieldProps) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");

  const save = useMutation({
    mutationFn: (apiKey: string) => api.putAccountKey(bearer, apiKey),
    onSuccess: () => {
      setDraft("");
      void queryClient.invalidateQueries({ queryKey: queryKeys.accounts });
      onSaved?.();
    },
  });

  const submit = () => {
    const apiKey = draft.trim();
    if (!apiKey || save.isPending) return;
    save.mutate(apiKey);
  };

  const error = errorText(save.error);
  return (
    <>
      <input
        className={`field ${inputClassName}`}
        type="password"
        {...omitUndefined({ "aria-label": ariaLabel })}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (isEnterSubmit(e)) submit();
        }}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
      />
      {error && <p className="m-0 text-[13px] text-err">{error}</p>}
      <button
        type="button"
        className="btn btn-primary h-10 self-start px-5"
        onClick={submit}
        disabled={save.isPending || draft.trim() === ""}
      >
        {save.isPending ? "Saving…" : submitLabel}
      </button>
      {/* Cleared on the next edit, so it can't linger over a stale field. */}
      {savedNote && save.isSuccess && draft === "" && savedNote}
    </>
  );
}
