export type View = {
  width: number;
  height: number;
  videoWidth: number;
  videoHeight: number;
  scale: number;
  panX: number;
  panY: number;
};

export function imageRect(view: View) {
  if (!view.videoWidth || !view.videoHeight) return { x: view.width / 2, y: view.height / 2, width: 0, height: 0 };
  const fit = Math.min(view.width / view.videoWidth, view.height / view.videoHeight);
  const width = view.videoWidth * fit * view.scale;
  const height = view.videoHeight * fit * view.scale;
  return {
    x: (view.width - width) / 2 + view.panX,
    y: (view.height - height) / 2 + view.panY,
    width,
    height,
  };
}

export function clampPan(view: View) {
  const image = imageRect(view);
  const maxX = Math.max(0, (image.width - view.width) / 2);
  const maxY = Math.max(0, (image.height - view.height) / 2);
  return {
    x: Math.max(-maxX, Math.min(maxX, view.panX)),
    y: Math.max(-maxY, Math.min(maxY, view.panY)),
  };
}

export function screenPoint(view: View, x: number, y: number, allowOutside = false) {
  const image = imageRect(view);
  if (!image.width || !image.height || (!allowOutside && (x < image.x || x > image.x + image.width || y < image.y || y > image.y + image.height))) return null;
  return {
    x: Math.round(Math.max(0, Math.min(1, (x - image.x) / image.width)) * 65535),
    y: Math.round(Math.max(0, Math.min(1, (y - image.y) / image.height)) * 65535),
  };
}

export function relativePoint(view: View, x: number, y: number, dx: number, dy: number) {
  const image = imageRect(view);
  if (!image.width || !image.height) return { x, y };
  return {
    x: Math.round(Math.max(0, Math.min(65535, x + dx * 65535 / image.width))),
    y: Math.round(Math.max(0, Math.min(65535, y + dy * 65535 / image.height))),
  };
}

export function followPoint(view: View, x: number, y: number) {
  const image = imageRect(view);
  const cursorX = image.x + x / 65535 * image.width;
  const cursorY = image.y + y / 65535 * image.height;
  const marginX = Math.min(48, view.width / 4);
  const marginY = Math.min(48, view.height / 4);
  return clampPan({
    ...view,
    panX: view.panX + (cursorX < marginX ? marginX - cursorX : cursorX > view.width - marginX ? view.width - marginX - cursorX : 0),
    panY: view.panY + (cursorY < marginY ? marginY - cursorY : cursorY > view.height - marginY ? view.height - marginY - cursorY : 0),
  });
}

export function zoomPan(view: View, scale: number, fromX: number, fromY: number, toX = fromX, toY = fromY) {
  const ratio = scale / view.scale;
  return clampPan({
    ...view,
    scale,
    panX: toX - view.width / 2 - ratio * (fromX - view.width / 2 - view.panX),
    panY: toY - view.height / 2 - ratio * (fromY - view.height / 2 - view.panY),
  });
}
