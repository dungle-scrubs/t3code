import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ContextMenuSource } from "@t3tools/contracts";

// Chromium uses no button for keyboard context menus and zero clicks for keyboard activation.
export function contextMenuSourceOf(
  event: Pick<MouseEvent, "type" | "button" | "detail">,
): ContextMenuSource {
  return (event.type === "click" ? event.detail === 0 : event.button === -1) ? "keyboard" : "mouse";
}

// Chromium on macOS emits no keyboard contextmenu; preventing the native default
// elsewhere keeps this fallback from opening the menu twice.
export function handleKeyboardContextMenu(event: ReactKeyboardEvent<HTMLElement>): void {
  if (event.defaultPrevented) return;
  if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
  event.preventDefault();
  event.stopPropagation();
  const target = event.currentTarget;
  const bounds = target.getBoundingClientRect();
  target.dispatchEvent(
    new PointerEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: -1,
      detail: 0,
      clientX: bounds.left,
      clientY: bounds.bottom,
    }),
  );
}
