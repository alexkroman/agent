// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

/**
 * What a `<Form>` hands its `onSubmit` — `collectValues`, control by control.
 *
 * That object is the whole contract — it goes straight into a workflow's input,
 * where a zod schema is waiting — so the assertions here are about TYPES and
 * OMISSIONS rather than about rendering: `"3"` where a number belongs is a
 * rejected run, and an empty optional field that arrives as `null` is a value
 * the user never supplied. Driven through a real `<Form>` (moved here from
 * `form.test.tsx`), because the values come off the DOM the form renders; the
 * file controls are `form-fields.test.tsx`'s.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { ThemeProvider } from "../context.ts";
import { collectValues } from "./_form-values.ts";
import {
  CheckboxField,
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

describe("collectValues, called directly", () => {
  test("reads any form, and a control with no name contributes nothing", async () => {
    // Exported for a caller doing its own submit handling, so it must not
    // depend on `<Form>` having rendered the element.
    const form = document.createElement("form");
    form.innerHTML =
      '<input name="topic" value="kittens"><input value="anonymous"><textarea>x</textarea>';
    expect(await collectValues(form)).toEqual({ topic: "kittens" });
  });
});
