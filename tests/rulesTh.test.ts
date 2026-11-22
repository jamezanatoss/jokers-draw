import { describe, expect, it } from 'vitest';
import {
  Category,
  type Action,
  CATEGORY_NAMES,
  applyAction,
  compareHands,
  evaluateHand,
  fullDeck,
  legalActions,
  mulberry32,
  newHand,
  parseCards,
} from '../src/engine';
import { sortedDisplay } from '../src/ui/animation';
import { RANKINGS } from '../src/ui/text';
import { TH_EXAMPLES, rulesHtmlTh } from '../src/ui/rulesTh';

/** Every example hand in the Thai rules must say exactly what the engine does. */
describe('Thai rules examples match the engine', () => {
  it('each ranking example is that category, in order, matching the English panel', () => {
    expect(TH_EXAMPLES.rankings).toHaveLength(RANKINGS.length);
    TH_EXAMPLES.rankings.forEach((r, i) => {
      expect(r.name).toBe(RANKINGS[i].name);
      expect(CATEGORY_NAMES[evaluateHand(parseCards(r.hand)).category]).toBe(r.name);
    });
    // High Card can never happen (five different ranks are always 10-J-Q-K-A): it is not listed.
    expect(RANKINGS.map((r) => r.name)).not.toContain(CATEGORY_NAMES[Category.HighCard]);
    expect(rulesHtmlTh('')).not.toContain(CATEGORY_NAMES[Category.HighCard]);
    expect(rulesHtmlTh('')).not.toContain('(ไพ่สูง)');
  });

  it('Joker rule example: trips of Aces with the Joker lose to natural trips of Kings', () => {
    const a = parseCards(TH_EXAMPLES.joker.withJoker);
    const b = parseCards(TH_EXAMPLES.joker.natural);
    expect(a.filter((c) => b.includes(c))).toEqual([]); // both hands can be dealt together
    expect(evaluateHand(a).category).toBe(Category.ThreeOfAKind);
    expect(evaluateHand(b).category).toBe(Category.ThreeOfAKind);
    expect(compareHands(a, b)).toMatchObject({ winner: 1, reason: 'jokerRule' });
  });

  it('suit tiebreak example: the pair holding A♠ wins', () => {
    const r = compareHands(parseCards(TH_EXAMPLES.suit.spade), parseCards(TH_EXAMPLES.suit.heart));
    expect(r).toMatchObject({ winner: 0, reason: 'suit' });
  });

  it('sort example: 10 J Q K A, lower suit on the left, Joker last', () => {
    expect(sortedDisplay(parseCards(TH_EXAMPLES.sort.unsorted))).toEqual(parseCards(TH_EXAMPLES.sort.sorted));
  });

  it('CALL example flow: AI raises to 2, you CALL 3, AI may only ACCEPT (3) or DROP', () => {
    const { aiRaise, youCall } = TH_EXAMPLES.call;
    let s = newHand([12, 12], 1, mulberry32(1)); // AI (player 1) acts first
    s = applyAction(s, { type: 'raise', to: aiRaise });
    s = applyAction(s, { type: 'exchange', cards: s.hands[1].slice(0, 3) });
    s = applyAction(s, { type: 'call', to: youCall });
    expect(legalActions(s)).toMatchObject({ accept: true, drop: true, raise: null, bet: null, call: null, exchange: null });
    const accepted = applyAction(s, { type: 'accept' } as Action);
    expect(accepted.bets).toEqual([youCall, youCall]);
    const dropped = applyAction(s, { type: 'drop' });
    expect(dropped.outcome).toMatchObject({ winner: 0, gain: aiRaise });
  });

  it('CALL must add at least 1: the Thai example amount is legal, N itself is not', () => {
    let s = newHand([12, 12], 1, mulberry32(2));
    s = applyAction(s, { type: 'raise', to: TH_EXAMPLES.call.aiRaise });
    s = applyAction(s, { type: 'exchange', cards: [] });
    expect(legalActions(s).call).toEqual({ min: TH_EXAMPLES.call.aiRaise + 1, max: 5 });
    expect(TH_EXAMPLES.call.youCall).toBeGreaterThanOrEqual(TH_EXAMPLES.call.aiRaise + 1);
  });

  it('final round example: a RAISE to 5 gives exactly one BET-5-or-DROP turn, then showdown', () => {
    let s = newHand([12, 12], 1, mulberry32(3));
    s = applyAction(s, { type: 'raise', to: TH_EXAMPLES.final.aiRaise });
    s = applyAction(s, { type: 'exchange', cards: s.hands[1].slice(0, 1) });
    expect(legalActions(s)).toMatchObject({ final: true, bet: { min: 5, max: 5 }, drop: true, call: null, raise: null });
    s = applyAction(s, { type: 'bet' });
    s = applyAction(s, { type: 'exchange', cards: s.hands[0].slice(0, 2) });
    expect(s.outcome!.kind).toBe('showdown');
  });

  it('the Thai page renders every example with real card components', () => {
    const html = rulesHtmlTh('');
    for (const h of ['ภาพรวม', 'ไพ่และเหรียญ', 'ลำดับการเล่น', 'คำสั่ง', 'ลำดับมือไพ่', 'กฎ Joker', 'การตัดสินเมื่อมือเท่ากัน', 'ตั้งค่า']) {
      expect(html).toContain(h);
    }
    for (const n of ['Full House (ฟูลเฮาส์)', 'DROP', 'RAISE', 'BET', 'CALL', 'Joker']) expect(html.replace(/<[^>]+>/g, '')).toContain(n.replace(/<[^>]+>/g, ''));
    expect((html.match(/class="card face/g) ?? []).length).toBeGreaterThan(40);
    expect(fullDeck().length).toBe(21);
  });
});

describe('English hand-ranking panel examples', () => {
  it('every example is the category it illustrates', () => {
    for (const r of RANKINGS) {
      const cards = parseCards(r.example.replace('★', 'JK').replace(/♠/g, 'S').replace(/♥/g, 'H').replace(/♦/g, 'D').replace(/♣/g, 'C'));
      expect(CATEGORY_NAMES[evaluateHand(cards).category], r.name).toBe(r.name);
    }
  });
});
