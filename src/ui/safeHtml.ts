/**
 * Last line of defence against broken labels: the UI must never show the literal text
 * "undefined", "null" or "NaN" (a field read before its data arrived, a missing mapping…).
 *
 * Every big innerHTML write goes through `guardHtml`. If one of those words would be rendered,
 * it is replaced by "—" and, in development, a warning names the place so the real cause can be
 * fixed. The game's own text never contains these words.
 */
const BAD = /\b(undefined|null|NaN)\b/g;

export function guardHtml(html: string, where: string): string {
  BAD.lastIndex = 0;
  if (!BAD.test(html)) return html;
  if (import.meta.env.DEV) {
    BAD.lastIndex = 0;
    const m = BAD.exec(html)!;
    const around = html.slice(Math.max(0, m.index - 80), m.index + 40).replace(/\s+/g, ' ');
    console.warn(`[ui-guard] "${m[0]}" would be rendered in ${where}: …${around}…`);
  }
  return html.replace(BAD, '—');
}

/** Set an element's HTML through the guard. */
export function setHtml(el: Element, html: string, where: string): void {
  el.innerHTML = guardHtml(html, where);
}
