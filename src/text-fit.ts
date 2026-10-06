import { measureLineStats, measureNaturalWidth, prepareWithSegments } from "@chenglou/pretext";

export async function watchTextFit(root: ParentNode = document): Promise<() => void> {
  const elements = new Set(root.querySelectorAll<HTMLElement>("[data-fit]"));
  let fontsReady = true;
  try {
    await Promise.all([400, 500, 600].map(weight => document.fonts.load(`${weight} 14px "IBM Plex Sans"`)));
  } catch {
    fontsReady = false;
  }
  const cache = new WeakMap<HTMLElement, { signature: string; prepared: ReturnType<typeof prepareWithSegments> }>();
  const measure = () => {
    const results = Array.from(elements).map(element => {
      if (!element.getClientRects().length) return [element, "hidden"] as const;
      if (!fontsReady) return [element, "unavailable"] as const;
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
    const panel = root.querySelector<HTMLElement>(".host-layout");
    if (panel) {
      // Try the bounded layout before deciding whether enlarged text needs
      // the whole page to reflow. Saved rows have their own pagination budget.
      if (document.body.dataset.panelFit === "reflow") document.body.dataset.panelFit = "fits";
      const regions = panel.querySelectorAll<HTMLElement>(".your-desktop, .host-header, .host-footer, .host-actions, .quick-connect");
      let overflow = Array.from(regions).some(region => region.getClientRects().length &&
        (region.scrollWidth > region.clientWidth + 1 || region.scrollHeight > region.clientHeight + 1));
      const list = panel.querySelector<HTMLElement>(".saved-list");
      const onlyRow = list?.childElementCount === 1 ? list.querySelector<HTMLElement>(".saved-computer") : null;
      if (onlyRow) overflow ||= onlyRow.scrollWidth > onlyRow.clientWidth + 1 || onlyRow.scrollHeight > onlyRow.clientHeight + 1;
      const fit = overflow ? "reflow" : "fits";
      if (document.body.dataset.panelFit !== fit) document.body.dataset.panelFit = fit;
    }
  };
  let frame = 0;
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure(); });
  };
  const observer = new ResizeObserver(schedule);
  window.addEventListener("resize", schedule);
  for (const element of elements) observer.observe(element);
  const content = new MutationObserver(() => {
    for (const element of elements) {
      if (!element.isConnected) { observer.unobserve(element); elements.delete(element); }
    }
    for (const element of root.querySelectorAll<HTMLElement>("[data-fit]")) {
      if (!elements.has(element)) { elements.add(element); observer.observe(element); }
    }
    schedule();
  });
  content.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["hidden"] });
  measure();
  return () => { observer.disconnect(); content.disconnect(); window.removeEventListener("resize", schedule); cancelAnimationFrame(frame); };
}
