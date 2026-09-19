export type WindowActivation = "user" | "background-hidden";

/**
 * Reloading the renderer inside the existing native window preserves its
 * visibility, bounds, z-order, and focus state. Recovery never creates or
 * raises a replacement BrowserWindow.
 */
export function reloadRendererWithoutActivation(target: Readonly<{
  isDestroyed: () => boolean;
  reload: () => void;
}>): boolean {
  if (target.isDestroyed()) return false;
  target.reload();
  return true;
}
