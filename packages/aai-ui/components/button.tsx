// Copyright 2025 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import type { CSSProperties, ReactNode } from "react";
import { useTheme } from "../context.ts";

export type ButtonVariant = "default" | "secondary" | "ghost";
export type ButtonSize = "default" | "lg";

const LG_STYLE: CSSProperties = {
  display: "grid",
  placeItems: "center",
  appearance: "none",
  margin: 0,
  padding: "12px 32px",
  lineHeight: 1,
};

const MUTED = "rgba(255,255,255,0.618)";

type ButtonProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children?: ReactNode;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className">;

export function Button({
  variant = "default",
  size = "default",
  className,
  children,
  style,
  ...rest
}: ButtonProps) {
  const theme = useTheme();

  const variantStyles: Record<ButtonVariant, CSSProperties> = {
    default: { background: theme.primary, color: "#fff", borderColor: "transparent" },
    secondary: {
      background: "rgba(255,255,255,0.059)",
      color: MUTED,
      borderColor: theme.border,
    },
    ghost: { background: "transparent", color: MUTED, borderColor: theme.border },
  };
  const variantStyle = variantStyles[variant];

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
