import { measureLineStats, measureNaturalWidth, prepareWithSegments } from "@chenglou/pretext";

export async function watchTextFit(root: ParentNode = document): Promise<() => void> {
  await document.fonts.load('400 14px "IBM Plex Sans"');
  await document.fonts.load('500 14px "IBM Plex Sans"');
  await document.fonts.load('600 20px "IBM Plex Sans"');
  const elements = Array.from(root.querySelectorAll<HTMLElement>("[data-fit]"));
  const measure = () => {
    for (const element of elements) {
      const style = getComputedStyle(element);
      const width = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const height = element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      const font = `${style.fontWeight} ${style.fontSize} "IBM Plex Sans"`;
      const prepared = prepareWithSegments(element.textContent ?? "", font, { letterSpacing: parseFloat(style.letterSpacing) || 0 });
      const stats = measureLineStats(prepared, Math.max(1, width));
      const lineHeight = parseFloat(style.lineHeight);
      const isSingle = style.whiteSpace === "nowrap";
      const fits = width > 0 && height > 0 && stats.lineCount * lineHeight <= height + 1 &&
        (!isSingle || (stats.lineCount === 1 && measureNaturalWidth(prepared) <= width - 1));
      element.dataset.textFit = fits ? "fits" : "reflow";
    }
  };
  const observer = new ResizeObserver(measure);
  for (const element of elements) observer.observe(element);
  measure();
  return () => observer.disconnect();
}
