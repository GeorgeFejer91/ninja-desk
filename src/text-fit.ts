import { measureLineStats, measureNaturalWidth, prepareWithSegments } from "@chenglou/pretext";

export async function watchTextFit(root: ParentNode = document): Promise<() => void> {
  const elements = Array.from(root.querySelectorAll<HTMLElement>("[data-fit]"));
  try {
    await Promise.all([400, 500, 600].map(weight => document.fonts.load(`${weight} 14px "IBM Plex Sans"`)));
  } catch {
    for (const element of elements) element.dataset.textFit = "unavailable";
    return () => {};
  }
  const cache = new WeakMap<HTMLElement, { signature: string; prepared: ReturnType<typeof prepareWithSegments> }>();
  const measure = () => {
    const results = elements.map(element => {
      if (!element.getClientRects().length) return [element, "hidden"] as const;
      try {
      const style = getComputedStyle(element);
      const width = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const height = element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      if (!document.fonts.check(font) || !style.fontFamily.includes("IBM Plex Sans")) return [element, "unavailable"] as const;
      const text = element.textContent ?? "";
      const spacing = parseFloat(style.letterSpacing) || 0;
      const signature = `${text}|${font}|${spacing}`;
      const previous = cache.get(element);
      const prepared = previous?.signature === signature ? previous.prepared : prepareWithSegments(text, font, { letterSpacing: spacing });
      cache.set(element, { signature, prepared });
      const stats = measureLineStats(prepared, Math.max(1, width));
      const lineHeight = parseFloat(style.lineHeight);
      const isSingle = style.whiteSpace === "nowrap";
      const fits = width > 0 && height > 0 && stats.maxLineWidth <= width + 1 && stats.lineCount * lineHeight <= height + 1 &&
        element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1 &&
        (!isSingle || (stats.lineCount === 1 && measureNaturalWidth(prepared) <= width - 1));
      return [element, fits ? "fits" : "reflow"] as const;
      } catch { return [element, "unavailable"] as const; }
    });
    for (const [element, result] of results) element.dataset.textFit = result;
  };
  let frame = 0;
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure(); });
  };
  const observer = new ResizeObserver(schedule);
  for (const element of elements) observer.observe(element);
  const content = new MutationObserver(schedule);
  content.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["hidden"] });
  measure();
  return () => { observer.disconnect(); content.disconnect(); cancelAnimationFrame(frame); };
}
