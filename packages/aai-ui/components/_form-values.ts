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

import type { FileRead, FileValue, FormValues } from "./form-types.ts";

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
    } else if (
      (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) &&
      element.name !== ""
    )
      values[element.name] = element.value;
  }
  return values;
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
      const read = readMode(input.dataset.aaiRead);
      const described = await Promise.all(files.map((file) => describeFile(file, read)));
      values[input.name] = input.multiple ? described : described[0];
      return;
    }
    default:
      values[input.name] = input.value;
  }
}

/** The `data-aai-read` attribute as a {@link FileRead}, defaulting to `"none"`. */
function readMode(raw: string | undefined): FileRead {
  return raw === "text" || raw === "dataUrl" ? raw : "none";
}

/** One chosen file as a {@link FileValue}. */
async function describeFile(file: File, read: FileRead): Promise<FileValue> {
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
