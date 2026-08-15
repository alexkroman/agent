// Copyright 2026 the AAI authors. MIT license.
/**
 * Escape / click-away dismissal for the top bar's dropdown panels (Publish,
 * Account). Both are opened by a TOGGLE button, and that button must exempt
 * itself from the click-away handler: without the exemption, pressing a
 * pressed toggle is seen as "clicked away" first, closes the panel, and the
 * toggle's own click then reopens it — so the second press looks like it did
 * nothing. The toggle marks itself with `toggleAttr`; the panel is found by
 * ref.
 */

import type { RefObject } from "react";
import { useEffect, useRef } from "react";

export function useDismissablePanel(opts: {
  open: boolean;
  onClose: () => void;
  panel: RefObject<HTMLElement | null>;
  /** Bare attribute name the panel's toggle button carries. */
  toggleAttr: string;
}): void {
  const { open, onClose, panel, toggleAttr } = opts;
  // `onClose` is read through a ref rather than depended on, because every
  // caller passes an inline arrow: with it in the dependency list the effect
  // tore down and re-installed both window listeners on EVERY render of the
  // component holding the panel — which for the top bar's two dropdowns is
  // every SSE push into the studio's live queries, for as long as a panel is
  // open. The listeners only ever call the latest one, which is what a ref is.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (panel.current?.contains(target as Node)) return;
      if (target?.closest?.(`[${toggleAttr}]`)) return;
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, panel, toggleAttr]);
}
