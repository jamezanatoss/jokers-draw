/**
 * "Card swipe" hand animation, in two phases:
 *
 *   1. Swipe in (right → left): new cards slide in from the right edge of the hand, one after
 *      another, landing in their unsorted arrival order. Kept cards stay where they are.
 *   2. Swipe to sort (left → right): after a short pause the hand collapses into a tight stack
 *      on the left, then fans out left → right in sorted order (the Joker lands last, far right).
 *
 * The display-order helpers are pure (and unit-tested); `swipeHand` drives the DOM with the Web
 * Animations API. All timings live in SWIPE so they are easy to tweak.
 */
import { type Card, sortCards } from '../engine';

export const SWIPE = {
  /** Delay between consecutive cards (both phases). */
  staggerMs: 60,
  /** Travel time of one card (both phases). */
  cardMs: 210,
  /** Pause showing the unsorted hand between the phases. */
  pauseMs: 180,
  /** Collapse of the hand into a stack on the left. */
  collapseMs: 120,
  /** Discarded cards flying from the hand into the discard box (before the swipe-in). */
  discardMs: 300,
  /** Delay between consecutive discarded cards taking off. */
  discardStaggerMs: 40,
  /** How far beyond the right edge of the hand new cards start (px). */
  enterOffsetPx: 40,
  easing: 'cubic-bezier(0.2, 0.8, 0.3, 1)',
} as const;

/** Total duration (ms) of both phases for `newCards` arriving into a hand of `handSize`. */
export function swipeDuration(newCards: number, handSize = 5): number {
  const phase1 = newCards > 0 ? (newCards - 1) * SWIPE.staggerMs + SWIPE.cardMs : 0;
  const phase2 = SWIPE.collapseMs + (handSize - 1) * SWIPE.staggerMs + SWIPE.cardMs;
  return phase1 + SWIPE.pauseMs + phase2;
}

/** Final display order: by rank, then suit; Jokers last (far right). */
export function sortedDisplay(cards: readonly Card[]): Card[] {
  return sortCards(cards);
}

/**
 * Display order right after an exchange (phase 1): kept cards stay in their display positions and
 * the drawn cards fill the vacated positions left to right, in the order they arrived.
 * `vacated` are display indexes; `drawn` are the new cards in arrival order.
 */
export function exchangeDisplay(
  display: readonly Card[],
  vacated: readonly number[],
  drawn: readonly Card[],
): { order: Card[]; newIdx: number[] } {
  if (vacated.length !== drawn.length) throw new Error('One drawn card per vacated slot');
  const order = [...display];
  const newIdx = [...vacated].sort((a, b) => a - b);
  newIdx.forEach((slot, n) => (order[slot] = drawn[n]));
  return { order, newIdx };
}

export interface SwipeHooks {
  /** Re-render the hand's cards in sorted order and return the new card elements. */
  renderSorted: () => HTMLElement[];
  swish: () => void;
  /** A card lands after `delayMs`. */
  tick: (delayMs: number) => void;
}

const left = (el: Element) => el.getBoundingClientRect().left;

/**
 * Run both phases on a hand element whose cards are currently rendered in arrival order.
 * `newIdx` are the indexes (in DOM order) of the cards that just arrived.
 */
export async function swipeHand(handEl: HTMLElement, newIdx: readonly number[], hooks: SwipeHooks): Promise<void> {
  const cards = Array.from(handEl.querySelectorAll<HTMLElement>('.card'));
  if (!cards.length) return;
  const s = SWIPE;

  // Phase 1 — new cards swipe in from the right edge, one after another.
  if (newIdx.length) {
    hooks.swish();
    const rightEdge = handEl.getBoundingClientRect().right + s.enterOffsetPx;
    await Promise.all(
      newIdx.map((i, n) => {
        const el = cards[i];
        const delay = n * s.staggerMs;
        hooks.tick(delay + s.cardMs);
        return el.animate(
          [
            { transform: `translateX(${rightEdge - left(el)}px) rotate(4deg)`, opacity: 0 },
            { transform: 'none', opacity: 1 },
          ],
          { duration: s.cardMs, delay, easing: s.easing, fill: 'backwards' },
        ).finished;
      }),
    );
  }
  await new Promise((r) => setTimeout(r, s.pauseMs));

  // Phase 2a — collapse into a tight stack on the left.
  const x0 = left(cards[0]);
  await Promise.all(
    cards.map(
      (el) =>
        el.animate([{ transform: 'none' }, { transform: `translateX(${x0 - left(el)}px)` }], {
          duration: s.collapseMs,
          easing: 'ease-in',
          fill: 'forwards',
        }).finished,
    ),
  );

  // Phase 2b — fan out left → right in sorted order.
  const sorted = hooks.renderSorted();
  if (!sorted.length) return;
  hooks.swish();
  const x1 = left(sorted[0]);
  await Promise.all(
    sorted.map((el, i) => {
      const delay = i * s.staggerMs;
      hooks.tick(delay + s.cardMs);
      return el.animate([{ transform: `translateX(${x1 - left(el)}px)` }, { transform: 'none' }], {
        duration: s.cardMs,
        delay,
        easing: s.easing,
        fill: 'backwards',
      }).finished;
    }),
  );
}
