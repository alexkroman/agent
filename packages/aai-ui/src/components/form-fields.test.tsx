// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

/**
 * The field controls: the shell every field shares, the options a select is
 * built from, and what a file field contributes.
 *
 * The file specs (moved here from `form.test.tsx`) submit through a real
 * `<Form>`, because a file field's whole behaviour is the `data-aai-read`
 * attribute `collectValues` reads back; the rest render the control and read
 * the DOM it produced. Every other control's VALUE is `_form-values.test.tsx`'s.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { ThemeProvider } from "../context.ts";
import { Form, SubmitButton } from "./form.tsx";
import { CheckboxField, Field, FileField, SelectField, TextField } from "./form-fields.tsx";

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

describe("Field", () => {
  test("labels its control and puts the hint under it", () => {
    render(
      <ThemeProvider>
        <Field label="Accent" hint="Any CSS color." htmlFor="accent">
          <input id="accent" name="accent" />
        </Field>
      </ThemeProvider>,
    );
    expect(screen.getByLabelText("Accent").getAttribute("name")).toBe("accent");
    expect(screen.getByText("Any CSS color.").tagName).toBe("P");
  });

  test("without a label or hint it draws neither", () => {
    const { container } = render(
      <ThemeProvider>
        <Field>
          <input name="bare" />
        </Field>
      </ThemeProvider>,
    );
    expect(container.querySelector("label")).toBeNull();
    expect(container.querySelector("p")).toBeNull();
  });
});

describe("the controls", () => {
  test("`name` lands on the control and `className` on the wrapper", () => {
    const { container } = render(
      <ThemeProvider>
        <TextField name="topic" label="Topic" className="my-field" placeholder="kittens" />
      </ThemeProvider>,
    );
    const control = screen.getByLabelText("Topic");
    expect(control.getAttribute("name")).toBe("topic");
    expect(control.getAttribute("placeholder")).toBe("kittens");
    expect(control.className).not.toContain("my-field");
    expect(container.firstElementChild?.className).toContain("my-field");
  });

  test("a TextField may still ask for another input type", () => {
    render(
      <ThemeProvider>
        <TextField name="email" label="Email" type="email" />
      </ThemeProvider>,
    );
    expect(screen.getByLabelText("Email").getAttribute("type")).toBe("email");
  });

  test("a select is built from `options`, and `children` win when both are given", () => {
    render(
      <ThemeProvider>
        <SelectField
          name="lang"
          label="Language"
          options={["en", { value: "fr", label: "French" }]}
        />
        <SelectField name="size" label="Size" options={["ignored"]}>
          <option value="s">Small</option>
        </SelectField>
      </ThemeProvider>,
    );
    const lang = screen.getByLabelText("Language");
    expect(Array.from(lang.querySelectorAll("option"), (o) => [o.value, o.textContent])).toEqual([
      ["en", "en"],
      ["fr", "French"],
    ]);
    const size = screen.getByLabelText("Size");
    expect(Array.from(size.querySelectorAll("option"), (o) => o.value)).toEqual(["s"]);
  });

  test("a checkbox's label sits beside the box and still names it", () => {
    render(
      <ThemeProvider>
        <CheckboxField name="redact" label="Redact" />
      </ThemeProvider>,
    );
    expect(screen.getByLabelText("Redact").getAttribute("type")).toBe("checkbox");
  });

  test("a file field records its read mode for `collectValues`, `upload` winning", () => {
    render(
      <ThemeProvider>
        <FileField name="a" label="Plain" />
        <FileField name="b" label="Text" read="text" />
        <FileField name="c" label="Upload" upload read="text" />
      </ThemeProvider>,
    );
    expect(screen.getByLabelText("Plain").getAttribute("data-aai-read")).toBe("none");
    expect(screen.getByLabelText("Text").getAttribute("data-aai-read")).toBe("text");
    expect(screen.getByLabelText("Upload").getAttribute("data-aai-read")).toBe("upload");
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
