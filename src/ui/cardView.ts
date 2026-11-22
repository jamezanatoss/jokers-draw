import { type Card, RANK_LABELS, SUIT_SYMBOLS, cardName, isJoker, rankOf, suitOf } from '../engine';

export interface CardOpts {
  /** Render as a clickable button (player's hand). */
  button?: boolean;
  selected?: boolean;
  /** Extra classes (animations etc). */
  cls?: string;
  /** Inline style (animation delays). */
  style?: string;
  key?: string;
  disabled?: boolean;
  slot?: number;
}

function attrs(o: CardOpts, label: string): string {
  const parts = [`aria-label="${label}"`];
  if (o.key) parts.push(`data-key="${o.key}"`);
  if (o.slot !== undefined) parts.push(`data-slot="${o.slot}"`);
  if (o.style) parts.push(`style="${o.style}"`);
  if (o.button) {
    parts.push('type="button"', `aria-pressed="${o.selected ? 'true' : 'false'}"`);
    if (o.disabled) parts.push('disabled');
  }
  return parts.join(' ');
}

export function cardFace(c: Card, o: CardOpts = {}): string {
  const tag = o.button ? 'button' : 'div';
  const sel = o.selected ? ' selected' : '';
  const extra = o.cls ? ` ${o.cls}` : '';
  if (isJoker(c)) {
    return `<${tag} class="card face joker${sel}${extra}" data-card="${c}" ${attrs(o, 'Joker')}>
      <span class="corner tl">★</span>
      <span class="joker-art" aria-hidden="true"><span class="jk-star">✦</span><span class="jk-word">JOKER</span></span>
      <span class="corner br">★</span>
      ${o.selected ? '<span class="swap-tag">SWAP</span>' : ''}
    </${tag}>`;
  }
  const r = RANK_LABELS[rankOf(c)];
  const s = SUIT_SYMBOLS[suitOf(c)];
  const color = suitOf(c) === 1 || suitOf(c) === 2 ? 'red' : 'black';
  return `<${tag} class="card face ${color}${sel}${extra}" data-card="${c}" ${attrs(o, cardName(c))}>
    <span class="corner tl"><b>${r}</b><i>${s}</i></span>
    <span class="pip" aria-hidden="true">${s}</span>
    <span class="corner br"><b>${r}</b><i>${s}</i></span>
    ${o.selected ? '<span class="swap-tag">SWAP</span>' : ''}
  </${tag}>`;
}

export function cardBack(o: CardOpts = {}): string {
  const extra = o.cls ? ` ${o.cls}` : '';
  return `<div class="card back${extra}" ${attrs(o, 'Face-down card')}><span class="back-art" aria-hidden="true"></span></div>`;
}

/**
 * Small card for the discard box. Face down renders a plain back — the card's identity is not put
 * into the DOM at all.
 */
export function discardCard(c: Card, faceUp: boolean): string {
  if (!faceUp) return '<span class="dcard back" aria-hidden="true"></span>';
  if (isJoker(c)) return '<span class="dcard joker" title="Joker"><b>★</b><i>JK</i></span>';
  const red = suitOf(c) === 1 || suitOf(c) === 2;
  return `<span class="dcard ${red ? 'red' : ''}" title="${cardName(c)}"><b>${RANK_LABELS[rankOf(c)]}</b><i>${SUIT_SYMBOLS[suitOf(c)]}</i></span>`;
}

/** Inline mini-cards for text ("A♠ K♥ ..."). */
export function miniCards(cards: readonly Card[]): string {
  return cards
    .map((c) => {
      if (isJoker(c)) return '<span class="mini joker">★</span>';
      const red = suitOf(c) === 1 || suitOf(c) === 2;
      return `<span class="mini ${red ? 'red' : ''}">${RANK_LABELS[rankOf(c)]}${SUIT_SYMBOLS[suitOf(c)]}</span>`;
    })
    .join('');
}

/**
 * Example hand for the hand-ranking panel: five small cards (rank over suit, centred), from a text
 * example like "A♠ A♥ A♦ A♣ ★".
 */
export function rankExample(example: string): string {
  return example
    .split(' ')
    .map((t) => {
      if (t === '★') return '<span class="rk-card joker" title="Joker"><b>★</b><i>JK</i></span>';
      const suit = t.slice(-1);
      const red = suit === '♥' || suit === '♦';
      return `<span class="rk-card${red ? ' red' : ''}"><b>${t.slice(0, -1)}</b><i>${suit}</i></span>`;
    })
    .join('');
}

/** Same as miniCards but from a text example like "A♠ A♥ ★". */
export function miniFromText(example: string): string {
  if (example === '—') return '<span class="muted">—</span>';
  return example
    .split(' ')
    .map((t) => {
      if (t === '★') return '<span class="mini joker">★</span>';
      const red = t.includes('♥') || t.includes('♦');
      return `<span class="mini ${red ? 'red' : ''}">${t}</span>`;
    })
    .join('');
}
