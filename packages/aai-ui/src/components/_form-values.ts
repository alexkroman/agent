// Copyright 2026 the AAI authors. MIT license.
/**
 * Reading a `<form>`'s named controls into a plain object.
 *
 * Split from `form.tsx` because it is the half with no JSX in it and the half
 * that carries the rules: what a control CONTRIBUTES is the contract — the
 * object goes straight into a workflow's input, where a zod schema is waiting —
 * and each branch below is a decision about that rather than about rendering.
 *
 * See `form.tsx`'s module doc for why the values come off the DOM at all.
 */

import type { FileReadMode, FileValue, FormValues } from "./form-types.ts";

/**
 * Read one `<form>`'s named controls into a plain object.
 *
 * Exported for tests and for a caller doing its own submit handling.
 *
 * @internal
 */
export async function collectValues(form: HTMLFormElement): Promise<FormValues> {
  const values: FormValues = {};
  for (const element of Array.from(form.elements)) {
    if (element instanceof HTMLInputElement) {
      await readInput(element, values);
      // The `disabled` check was `readInput`'s alone, so a disabled
      // `<SelectField>` contributed a value where a disabled `<TextField>` did
      // not — one form, two answers to the same question.
    } else if (
      (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) &&
      element.name !== "" &&
      !element.disabled
    ) {
      values[element.name] =
        element instanceof HTMLSelectElement ? readSelect(element) : element.value;
    }
  }
  return values;
}

/**
 * One `<select>`, by arity.
 *
 * `HTMLSelectElement.value` is the FIRST selected option and nothing more, so a
 * `<SelectField multiple>` — which type-checks, since the props extend
 * `SelectHTMLAttributes` — contributed one string where its schema is waiting
 * for a list. `selectedOptions` is the whole of what the user picked; nothing
 * selected contributes `[]`, which is the honest answer for a control that is
 * present and empty rather than one that was left blank.
 */
function readSelect(select: HTMLSelectElement): string | string[] {
  if (!select.multiple) return select.value;
  return Array.from(select.selectedOptions, (option) => option.value);
}

/** One `<input>`, by type. */
async function readInput(input: HTMLInputElement, values: FormValues): Promise<void> {
  if (input.name === "" || input.disabled) return;
  switch (input.type) {
    case "checkbox":
      values[input.name] = input.checked;
      return;
    case "radio":
      // Only the selected member of a group contributes, and the unselected
      // ones must not erase it — hence the early return rather than a write.
      if (input.checked) values[input.name] = input.value;
      return;
    case "number":
    case "range": {
      // An empty optional number field contributes NOTHING rather than `NaN`:
      // `NaN` serializes to `null`, which a schema reads as a value the user
      // supplied. Omission is what "left blank" means.
      if (input.value === "") return;
      const value = input.valueAsNumber;
      values[input.name] = Number.isNaN(value) ? input.value : value;
      return;
    }
    case "file": {
      const files = Array.from(input.files ?? []);
      if (files.length === 0) return;
      const chosen = await readFiles(files, readMode(input.dataset.aaiRead));
      values[input.name] = input.multiple ? chosen : chosen[0];
      return;
    }
    default:
      values[input.name] = input.value;
  }
}

/**
 * The chosen files, as the field's `read` mode says to contribute them.
 *
 * An UPLOAD field contributes each `File` UNREAD. Reading it here would mean
 * holding a 200 MB recording in memory to describe it, and the thing that needs
 * the bytes is the upload request `useWorkflowSubmit` makes — which streams the
 * same `File` object straight to the agent.
 */
function readFiles(files: readonly File[], read: FileReadMode): Promise<(File | FileValue)[]> {
  if (read === "upload") return Promise.resolve([...files]);
  return Promise.all(files.map((file) => describeFile(file, read)));
}

/** The `data-aai-read` attribute as a {@link FileReadMode}, defaulting to `"none"`. */
function readMode(raw: string | undefined): FileReadMode {
  return raw === "text" || raw === "dataUrl" || raw === "upload" ? raw : "none";
}

/** One chosen file as a {@link FileValue}. */
async function describeFile(file: File, read: FileReadMode): Promise<FileValue> {
  const described: FileValue = {
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
  };
  if (read === "none") return described;
  return { ...described, content: read === "text" ? await file.text() : await dataUrl(file) };
}

/** A file as a `data:` URL. */
function dataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}
