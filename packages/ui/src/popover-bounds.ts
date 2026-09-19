/** PC-UI-003 / AS-004: popovers stay inside the window box after resize. */

export const CONTEXT_MENU_MARGIN = 8;
export const CONTEXT_MENU_WIDTH = 208;
export const CONTEXT_MENU_CONFIRM_WIDTH = 248;
// Tall enough for the complete task menu, including branch/export actions and its divider.
export const CONTEXT_MENU_HEIGHT = 268;

export function clampContextMenuPosition(
  x: number,
  y: number,
  viewportWidth: number,
  viewportHeight: number,
  confirming = false,
): { readonly x: number; readonly y: number } {
  const width = confirming ? CONTEXT_MENU_CONFIRM_WIDTH : CONTEXT_MENU_WIDTH;
  return {
    x: Math.max(CONTEXT_MENU_MARGIN, Math.min(x, viewportWidth - width)),
    y: Math.max(CONTEXT_MENU_MARGIN, Math.min(y, viewportHeight - CONTEXT_MENU_HEIGHT)),
  };
}
