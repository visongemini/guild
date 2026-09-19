export type WindowAreaSize = {
  readonly width: number;
  readonly height: number;
};

export type InitialWindowBounds = {
  readonly width: number;
  readonly height: number;
  readonly minWidth: number;
  readonly minHeight: number;
};

const WINDOW_MARGIN = 24;
const PREFERRED_WIDTH = 1280;
const PREFERRED_HEIGHT = 820;
const MINIMUM_WIDTH = 680;
const MINIMUM_HEIGHT = 520;

export function fitInitialWindowBounds(workArea: WindowAreaSize): InitialWindowBounds {
  const availableWidth = Math.max(1, workArea.width - WINDOW_MARGIN);
  const availableHeight = Math.max(1, workArea.height - WINDOW_MARGIN);
  const width = Math.min(PREFERRED_WIDTH, availableWidth);
  const height = Math.min(PREFERRED_HEIGHT, availableHeight);
  return {
    width,
    height,
    minWidth: Math.min(MINIMUM_WIDTH, width),
    minHeight: Math.min(MINIMUM_HEIGHT, height),
  };
}
