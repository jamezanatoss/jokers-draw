import { describe, expect, it } from 'vitest';
import { JOKER, JOKER2, parseCards } from '../src/engine';
import { SWIPE, exchangeDisplay, sortedDisplay, swipeDuration } from '../src/ui/animation';

describe('card swipe animation', () => {
  it('a full deal (5 new cards, both phases) takes at most ~1.2 s', () => {
    expect(swipeDuration(5)).toBeLessThanOrEqual(1200);
  });

  it('exchanges are shorter than a full deal', () => {
    for (let k = 0; k < 5; k++) expect(swipeDuration(k)).toBeLessThan(swipeDuration(5));
  });

  it('timings stay in the intended ranges', () => {
    expect(SWIPE.staggerMs).toBeGreaterThanOrEqual(60);
    expect(SWIPE.staggerMs).toBeLessThanOrEqual(80);
    expect(SWIPE.cardMs).toBeGreaterThanOrEqual(180);
    expect(SWIPE.cardMs).toBeLessThanOrEqual(260);
    expect(SWIPE.collapseMs).toBeLessThanOrEqual(150);
  });

  it('sorted display: by rank then suit, Joker always last (far right)', () => {
    expect(sortedDisplay(parseCards('JK AS 10H KD 10C'))).toEqual(parseCards('10C 10H KD AS JK'));
    expect(sortedDisplay(parseCards('AS JK2 QH QD 10C'))).toEqual([...parseCards('10C QD QH AS'), JOKER2]);
    expect(sortedDisplay([JOKER, 0, 1, 2, 3]).at(-1)).toBe(JOKER);
  });

  it('exchange: kept cards stay put, new cards fill the vacated slots left to right in arrival order', () => {
    const display = parseCards('10C JD QH KS AS');
    const drawn = parseCards('AH 10S'); // arrival order
    const { order, newIdx } = exchangeDisplay(display, [3, 1], drawn);
    expect(newIdx).toEqual([1, 3]);
    expect(order).toEqual(parseCards('10C AH QH 10S AS'));
    // ...and phase 2 then sorts it.
    expect(sortedDisplay(order)).toEqual(parseCards('10C 10S QH AH AS'));
  });

  it('exchange needs one drawn card per vacated slot', () => {
    expect(() => exchangeDisplay(parseCards('10C JD QH KS AS'), [0, 1], parseCards('AH'))).toThrow();
  });
});
