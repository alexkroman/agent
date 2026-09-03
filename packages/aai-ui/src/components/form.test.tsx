// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

/**
 * What a `<Form>` hands its `onSubmit`.
 *
 * That object is the whole contract — it goes straight into a workflow's input,
 * where a zod schema is waiting — so the assertions here are about TYPES and
 * OMISSIONS rather than about rendering: `"3"` where a number belongs is a
 * rejected run, and an empty optional field that arrives as `null` is a value
 * the user never supplied.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { ThemeProvider } from "../context.ts";
import {
  CheckboxField,
  FileField,
  Form,
  NumberField,
  SelectField,
  SubmitButton,
  TextAreaField,
  TextField,
} from "./form.tsx";

/** Render a form over `children` and return the recorded submit values. */
function renderForm(children: React.ReactNode) {
  const onSubmit = vi.fn();
  render(
    <ThemeProvider>
      <Form onSubmit={onSubmit}>
        {children}
        <SubmitButton>Go</SubmitButton>
      </Form>
    </ThemeProvider>,
  );
  return {
    onSubmit,
    submit: () => fireEvent.click(screen.getByRole("button", { name: "Go" })),
  };
}

/** The single recorded submission. */
async function submitted(onSubmit: ReturnType<typeof vi.fn>): Promise<Record<string, unknown>> {
  await waitFor(() => expect(onSubmit).toHaveBeenCalled());
  return onSubmit.mock.calls[0]?.[0] as Record<string, unknown>;
}

describe("collected values", () => {
  test("a text field contributes its string", async () => {
    const { onSubmit, submit } = renderForm(<TextField name="topic" label="Topic" />);
    fireEvent.change(screen.getByLabelText("Topic"), { target: { value: "kittens" } });
    submit();
    expect(await submitted(onSubmit)).toEqual({ topic: "kittens" });
  });

  test("a number field contributes a NUMBER, not the string the DOM holds", async () => {
    // The reason values come off the DOM rather than out of `FormData`: only
    // the element still knows it was `type="number"`, and `"3"` against
    // `z.number()` is a rejected run.
    const { onSubmit, submit } = renderForm(<NumberField name="limit" label="Limit" />);
    fireEvent.change(screen.getByLabelText("Limit"), { target: { value: "3" } });
    submit();
    expect(await submitted(onSubmit)).toEqual({ limit: 3 });
  });

  test("an empty optional number contributes nothing rather than NaN", async () => {
    // `NaN` serializes to `null`, which a schema reads as a value the user
    // supplied. Omission is what "left blank" means.
    const { onSubmit, submit } = renderForm(<NumberField name="limit" label="Limit" />);
    submit();
    expect(await submitted(onSubmit)).toEqual({});
  });

  test("a checkbox contributes a boolean either way", async () => {
    const { onSubmit, submit } = renderForm(<CheckboxField name="redact" label="Redact" />);
    submit();
    expect(await submitted(onSubmit)).toEqual({ redact: false });
  });

  test("a checked checkbox contributes true", async () => {
    const { onSubmit, submit } = renderForm(<CheckboxField name="redact" label="Redact" />);
    fireEvent.click(screen.getByLabelText("Redact"));
    submit();
    expect(await submitted(onSubmit)).toEqual({ redact: true });
  });

  test("a select and a textarea contribute their strings", async () => {
    const { onSubmit, submit } = renderForm(
      <>
        <SelectField name="lang" label="Language" options={["en", "fr"]} defaultValue="fr" />
        <TextAreaField name="notes" label="Notes" defaultValue="hi" />
      </>,
    );
    submit();
    expect(await submitted(onSubmit)).toEqual({ lang: "fr", notes: "hi" });
  });

  test("a plain named input a caller wrote themselves is collected too", async () => {
    // The point of reading the DOM: a field here is nothing but a styled
    // `<input>`, so a hand-written one composes with the generated ones.
    const { onSubmit, submit } = renderForm(
      <input name="custom" defaultValue="mine" aria-label="Custom" />,
    );
    submit();
    expect(await submitted(onSubmit)).toEqual({ custom: "mine" });
  });

  test("only the selected radio contributes", async () => {
    const { onSubmit, submit } = renderForm(
      <>
        <input type="radio" name="mode" value="fast" aria-label="Fast" />
        <input type="radio" name="mode" value="slow" aria-label="Slow" defaultChecked />
      </>,
    );
    submit();
    // An unselected member must not erase the selected one's value.
    expect(await submitted(onSubmit)).toEqual({ mode: "slow" });
  });

  test("a disabled field contributes nothing", async () => {
    const { onSubmit, submit } = renderForm(
      <TextField name="topic" label="Topic" defaultValue="x" disabled />,
    );
    submit();
    expect(await submitted(onSubmit)).toEqual({});
  });

  test("a multi-select contributes EVERY selected option, not just the first", async () => {
    // `HTMLSelectElement.value` is the first selected option, so this used to
    // hand a list-shaped schema one string.
    const { onSubmit, submit } = renderForm(
      <SelectField name="langs" label="Languages" options={["en", "fr", "de"]} multiple />,
    );
    const select = screen.getByLabelText("Languages") as HTMLSelectElement;
    for (const option of Array.from(select.options)) {
      option.selected = option.value !== "fr";
    }
    fireEvent.change(select);
    submit();
    expect(await submitted(onSubmit)).toEqual({ langs: ["en", "de"] });
  });

  test("a multi-select with nothing chosen contributes an empty list", async () => {
    const { onSubmit, submit } = renderForm(
      <SelectField name="langs" label="Languages" options={["en", "fr"]} multiple />,
    );
    submit();
    expect(await submitted(onSubmit)).toEqual({ langs: [] });
  });

  test("a disabled select and a disabled textarea contribute nothing either", async () => {
    // The `disabled` check was on `readInput` alone, so a disabled
    // `<SelectField>` contributed a value where a disabled `<TextField>` did not.
    const { onSubmit, submit } = renderForm(
      <>
        <SelectField name="lang" label="Language" options={["en"]} defaultValue="en" disabled />
        <TextAreaField name="notes" label="Notes" defaultValue="hi" disabled />
      </>,
    );
    submit();
    expect(await submitted(onSubmit)).toEqual({});
  });
});

describe("file fields", () => {
  test("describe the file rather than uploading it", async () => {
    // A workflow input is journaled and replayed on every resume, so the bytes
    // have no business in it — the default is metadata.
    const { onSubmit, submit } = renderForm(<FileField name="upload" label="Recording" />);
    const file = new File(["abc"], "standup.m4a", { type: "audio/mp4" });
    fireEvent.change(screen.getByLabelText("Recording"), { target: { files: [file] } });
    submit();
    expect(await submitted(onSubmit)).toMatchObject({
      upload: { name: "standup.m4a", type: "audio/mp4", size: 3 },
    });
    expect((await submitted(onSubmit)).upload).not.toHaveProperty("content");
  });

  test("contribute nothing when no file was chosen", async () => {
    const { onSubmit, submit } = renderForm(<FileField name="upload" label="Recording" />);
    submit();
    expect(await submitted(onSubmit)).toEqual({});
  });

  test("read the contents only when asked to", async () => {
    const { onSubmit, submit } = renderForm(<FileField name="ids" label="Ids" read="text" />);
    fireEvent.change(screen.getByLabelText("Ids"), {
      target: { files: [new File(["a,b,c"], "ids.csv", { type: "text/csv" })] },
    });
    submit();
    expect(await submitted(onSubmit)).toMatchObject({ ids: { content: "a,b,c" } });
  });

  test("contribute the FILE ITSELF when the field uploads", async () => {
    // The bytes still never reach the run input — `useWorkflowSubmit` stores
    // the file and substitutes its id — but they must reach the SUBMIT, unread:
    // describing a 200 MB recording here would mean holding it in memory.
    const { onSubmit, submit } = renderForm(
      <FileField name="recording" label="Recording" upload />,
    );
    const file = new File(["abc"], "standup.wav", { type: "audio/wav" });
    fireEvent.change(screen.getByLabelText("Recording"), { target: { files: [file] } });
    submit();
    expect((await submitted(onSubmit)).recording).toBe(file);
  });

  test("contribute an array when the field takes several", async () => {
    const { onSubmit, submit } = renderForm(
      <FileField name="uploads" label="Recordings" multiple />,
    );
    fireEvent.change(screen.getByLabelText("Recordings"), {
      target: { files: [new File(["a"], "one.m4a"), new File(["bb"], "two.m4a")] },
    });
    submit();
    const values = await submitted(onSubmit);
    expect(values.uploads).toHaveLength(2);
  });
});

describe("submitting", () => {
  test("cannot be submitted twice while the first is still in flight", async () => {
    // A workflow run is expensive and not idempotent; a double-click must not
    // start two.
    const { promise, resolve } = Promise.withResolvers<void>();
    const onSubmit = vi.fn(() => promise);
    render(
      <ThemeProvider>
        <Form onSubmit={onSubmit}>
          <SubmitButton>Go</SubmitButton>
        </Form>
      </ThemeProvider>,
    );
    const button = screen.getByRole("button", { name: "Go" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    resolve();
  });

  test("shows the caller's error, since the interesting ones are the server's", () => {
    render(
      <ThemeProvider>
        <Form onSubmit={vi.fn()} error="agent unavailable, retry shortly" />
      </ThemeProvider>,
    );
    expect(screen.getByRole("alert").textContent).toContain("agent unavailable");
  });

  test("a pending SubmitButton is disabled and says what it is doing", () => {
    render(
      <ThemeProvider>
        <Form onSubmit={vi.fn()}>
          <SubmitButton pending>Transcribe</SubmitButton>
        </Form>
      </ThemeProvider>,
    );
    // Pending is the WORK, not the submit: a run outlives its POST, so the
    // button stays busy until the run is done.
    const button = screen.getByRole("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("Working…");
  });
});
