// Copyright 2025 the AAI authors. MIT license.

import clsx from "clsx";
import type * as preact from "preact";

/**
 * Visual style of a {@link Button}.
 *
 * - `"default"` — Primary filled button (accent background).
 * - `"secondary"` — Muted surface background with border.
 * - `"ghost"` — Transparent background with border.
 *
 * @public
 */
export type ButtonVariant = "default" | "secondary" | "ghost";

/**
 * Size preset for a {@link Button}.
 *
 * - `"default"` — Compact (height 2rem / 32 px).
 * - `"lg"` — Large with generous padding, suitable for primary CTAs.
 *
 * @public
 */
export type ButtonSize = "default" | "lg";

const LG_STYLE: preact.JSX.CSSProperties = {
  display: "grid",
  placeItems: "center",
  appearance: "none",
  margin: 0,
  padding: "12px 32px",
  lineHeight: 1,
};

/**
 * A styled button with variant and size presets.
 *
 * Accepts all standard `<button>` HTML attributes in addition to the props
 * listed below.
 *
 * @example
 * ```tsx
 * <Button variant="secondary" onClick={handleClick}>
 *   Stop
 * </Button>
 *
 * <Button size="lg" className="w-full">
 *   Start Conversation
 * </Button>
 * ```
 *
 * @param variant - Visual style (`"default"` | `"secondary"` | `"ghost"`). Defaults to `"default"`.
 * @param size - Size preset (`"default"` | `"lg"`). Defaults to `"default"`.
 * @param className - Additional CSS class names.
 * @param children - Button label / content.
 *
 * @public
 */
export function Button({
  variant = "default",
  size = "default",
  className,
  children,
  ...rest
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children?: preact.ComponentChildren;
} & Omit<preact.JSX.HTMLAttributes<HTMLButtonElement>, "className">) {
  return (
    <button
      type="button"
      style={size === "lg" ? LG_STYLE : undefined}
      class={clsx(
        size !== "lg" &&
          "flex items-center justify-center appearance-none m-0 h-8 px-3 py-1.5 w-fit leading-none",
        "rounded-aai text-sm font-medium cursor-pointer border outline-none",
        variant === "secondary" && "bg-aai-surface-hover text-aai-text-secondary border-aai-border",
        variant === "ghost" && "bg-transparent text-aai-text-secondary border-aai-border",
        variant === "default" && "bg-aai-primary text-white border-transparent",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
