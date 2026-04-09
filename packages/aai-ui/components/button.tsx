// Copyright 2025 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import type { CSSProperties, ReactNode } from "react";
import { useTheme } from "../context.ts";

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

const LG_STYLE: CSSProperties = {
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
  style,
  ...rest
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children?: ReactNode;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className">) {
  const theme = useTheme();

  let variantStyle: CSSProperties;
  if (variant === "default") {
    variantStyle = { background: theme.primary, color: "#fff", borderColor: "transparent" };
  } else if (variant === "secondary") {
    variantStyle = {
      background: "rgba(255,255,255,0.059)",
      color: "rgba(255,255,255,0.618)",
      borderColor: theme.border,
    };
  } else {
    variantStyle = {
      background: "transparent",
      color: "rgba(255,255,255,0.618)",
      borderColor: theme.border,
    };
  }

  return (
    <button
      type="button"
      style={{
        ...(size === "lg" ? LG_STYLE : undefined),
        ...variantStyle,
        ...style,
      }}
      className={clsx(
        size !== "lg" &&
          "flex items-center justify-center appearance-none m-0 h-8 px-3 py-1.5 w-fit leading-none",
        "rounded-aai text-sm font-medium cursor-pointer border outline-none",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
