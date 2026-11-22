import {
  type Card,
  type Rank,
  HAND_SIZE,
  NUM_RANKS,
  NUM_SUITS,
  RANK_NAMES,
  RANK_PLURALS,
  SPADES,
  SUIT_SYMBOLS,
  cardLabel,
  isJoker,
  makeCard,
  rankOf,
  suitOf,
} from './cards';

/** Hand categories, higher value = stronger. */
export const Category = {
  HighCard: 0,
  OnePair: 1,
  TwoPair: 2,
  ThreeOfAKind: 3,
  FullHouse: 4,
  RoyalStraight: 5,
  FourOfAKind: 6,
  RoyalStraightFlush: 7,
  FiveOfAKind: 8,
} as const;
export type Category = (typeof Category)[keyof typeof Category];

export const CATEGORY_NAMES: Record<Category, string> = {
  0: 'High Card',
  1: 'One Pair',
  2: 'Two Pair',
  3: 'Three of a Kind',
  4: 'Full House',
  5: 'Royal Straight',
  6: 'Four of a Kind',
  7: 'Royal Straight Flush',
  8: 'Five of a Kind',
};

export interface Group {
  rank: Rank;
  count: number;
}

export interface Evaluation {
  /** The five original cards. */
  cards: Card[];
  category: Category;
  /** Rank groups of the (Joker-substituted) hand, sorted by count desc, then rank desc. */
  groups: Group[];
  /** Ranks compared in step 2 of the tiebreak (defining groups only, no kickers). */
  compareRanks: Rank[];
  /**
   * The highest card of the top defining group, used for the suit tiebreak.
   * A Joker counts as the ♠ of the rank it became.
   */
  topCard: Card;
  /** True if `topCard` is the Joker (it then loses to an identical real card). */
  topCardIsJoker: boolean;
  /**
   * Highest real (non-Joker) card. Last-resort tiebreak, only reachable when both hands hold a
   * Joker and both top cards are Jokers standing for the same card (2-Joker mode).
   */
  highestReal: Card;
  usesJoker: boolean;
  /** What the Joker became (rank + suit used to build the category), or null. */
  jokerAs: Card | null;
  /**
   * Total-order key. A higher score always wins, and two hands that can be dealt
   * at the same time never share a score (there are no ties).
   */
  score: number;
}

export type TieBreak = 'category' | 'jokerRule' | 'rank' | 'suit' | 'realCard' | 'highestReal';

export interface Comparison {
  /** 0 if the first hand wins, 1 if the second. */
  winner: 0 | 1;
  reason: TieBreak;
  /** Human-readable explanation of what decided it. */
  explanation: string;
}

interface Partial {
  category: Category;
  groups: Group[];
  compareRanks: Rank[];
  topCard: Card;
  topCardIsJoker: boolean;
  highestReal: Card;
  score: number;
}

/**
 * Evaluate five concrete (rank, suit) slots. `jokerIdx` marks the slot holding
 * the Joker (-1 if none); that slot's rank/suit is the substitution.
 */
function evalSlots(ranks: number[], suits: number[], jokerIdx: number): Partial {
  const counts = [0, 0, 0, 0, 0];
  for (let i = 0; i < HAND_SIZE; i++) counts[ranks[i]]++;

  const groups: Group[] = [];
  for (let r = NUM_RANKS - 1; r >= 0; r--) {
    if (counts[r] > 0) groups.push({ rank: r as Rank, count: counts[r] });
  }
  // Stable sort keeps rank-desc order among equal counts.
  groups.sort((a, b) => b.count - a.count);

  let category: Category;
  const c0 = groups[0].count;
  const c1 = groups.length > 1 ? groups[1].count : 0;
  if (groups.length === 5) {
    // Five distinct ranks out of five possible ranks => always 10-J-Q-K-A.
    const flush = suits.every((s) => s === suits[0]);
    category = flush ? Category.RoyalStraightFlush : Category.RoyalStraight;
  } else if (c0 === 5) category = Category.FiveOfAKind;
  else if (c0 === 4) category = Category.FourOfAKind;
  else if (c0 === 3 && c1 === 2) category = Category.FullHouse;
  else if (c0 === 3) category = Category.ThreeOfAKind;
  else if (c0 === 2 && c1 === 2) category = Category.TwoPair;
  else if (c0 === 2) category = Category.OnePair;
  else category = Category.HighCard; // unreachable with this deck, kept for completeness

  const compareRanks: Rank[] =
    category === Category.TwoPair ? [groups[0].rank, groups[1].rank] : [groups[0].rank];

  // Highest card of the top defining group (for straights / high card: the highest card).
  const topRank = groups[0].rank;
  let topVal = -1;
  let topIsJoker = false;
  for (let i = 0; i < HAND_SIZE; i++) {
    if (ranks[i] !== topRank) continue;
    const joker = i === jokerIdx;
    const val = topRank * 4 + (joker ? SPADES : suits[i]);
    // On equal value a real card is preferred (a real card beats an identical Joker).
    if (val > topVal || (val === topVal && topIsJoker && !joker)) {
      topVal = val;
      topIsJoker = joker;
    }
  }

  let highestReal = -1;
  for (let i = 0; i < HAND_SIZE; i++) {
    if (i !== jokerIdx) highestReal = Math.max(highestReal, ranks[i] * 4 + suits[i]);
  }

  const usesJoker = jokerIdx >= 0;
  // Joker rule folded into the key, right below the category: within the same category a
  // hand with the Joker ranks below every hand without one. Two Joker hands compare normally.
  const noJoker = usesJoker ? 0 : 1;
  const r1 = compareRanks[0];
  const r2 = compareRanks.length > 1 ? compareRanks[1] : 0;
  const tie = topVal * 2 + (topIsJoker ? 0 : 1); // 0..39
  const score = ((((category * 2 + noJoker) * 5 + r1) * 5 + r2) * 40 + tie) * 20 + highestReal;

  return { category, groups, compareRanks, topCard: topVal, topCardIsJoker: topIsJoker, highestReal, score };
}

/** Maximum possible score + 1 (useful for lookup tables). */
export const SCORE_LIMIT = ((((8 * 2 + 1) * 5 + 4) * 5 + 4) * 40 + 39) * 20 + 20;

/** Evaluate a 5-card hand. The Joker becomes whatever gives the best hand. */
export function evaluateHand(cards: readonly Card[]): Evaluation {
  if (cards.length !== HAND_SIZE) throw new Error(`A hand has ${HAND_SIZE} cards, got ${cards.length}`);
  if (new Set(cards).size !== HAND_SIZE) throw new Error('Duplicate card in hand');
  if (cards.filter(isJoker).length > 1) throw new Error('A hand can never hold two Jokers');

  const ranks: number[] = new Array(HAND_SIZE);
  const suits: number[] = new Array(HAND_SIZE);
  let jokerIdx = -1;
  for (let i = 0; i < HAND_SIZE; i++) {
    const c = cards[i];
    if (isJoker(c)) {
      jokerIdx = i;
      ranks[i] = 0;
      suits[i] = 0;
    } else {
      ranks[i] = rankOf(c);
      suits[i] = suitOf(c);
    }
  }

  if (jokerIdx < 0) {
    const p = evalSlots(ranks, suits, -1);
    return { cards: [...cards], ...p, usesJoker: false, jokerAs: null };
  }

  // Try every rank/suit for the Joker; prefer ♠ when the suit is irrelevant.
  let best: Partial | null = null;
  let bestAs = -1;
  for (let r = NUM_RANKS - 1; r >= 0; r--) {
    for (let s = NUM_SUITS - 1; s >= 0; s--) {
      ranks[jokerIdx] = r;
      suits[jokerIdx] = s;
      const p = evalSlots(ranks, suits, jokerIdx);
      if (!best || p.score > best.score) {
        best = p;
        bestAs = makeCard(r, s);
      }
    }
  }
  return { cards: [...cards], ...best!, usesJoker: true, jokerAs: bestAs };
}

/** Convenience: score only. */
export function scoreHand(cards: readonly Card[]): number {
  return evaluateHand(cards).score;
}

function topCardText(e: Evaluation): string {
  return e.topCardIsJoker ? `Joker-as-${cardLabel(e.topCard)}` : cardLabel(e.topCard);
}

/**
 * Compare two hands and explain which tiebreak step decided the result.
 * Always agrees with comparing `score`.
 */
export function compareEvaluations(a: Evaluation, b: Evaluation): Comparison {
  const win = (aWins: boolean, reason: TieBreak, explanation: string): Comparison => ({
    winner: aWins ? 0 : 1,
    reason,
    explanation,
  });
  const nameA = CATEGORY_NAMES[a.category];
  const nameB = CATEGORY_NAMES[b.category];

  if (a.category !== b.category) {
    const aWins = a.category > b.category;
    return win(aWins, 'category', `${aWins ? nameA : nameB} beats ${aWins ? nameB : nameA}.`);
  }

  if (a.usesJoker !== b.usesJoker) {
    return win(!a.usesJoker, 'jokerRule', `Both have ${withArticle(nameA)} — Joker rule: the hand with the Joker loses.`);
  }

  for (let i = 0; i < a.compareRanks.length; i++) {
    const ra = a.compareRanks[i];
    const rb = b.compareRanks[i];
    if (ra !== rb) {
      const aWins = ra > rb;
      const hi = RANK_PLURALS[aWins ? ra : rb];
      const lo = RANK_PLURALS[aWins ? rb : ra];
      let what: string;
      if (a.category === Category.TwoPair) what = i === 0 ? 'Higher pair' : 'Second pair';
      else if (a.category === Category.FullHouse) what = 'Higher triple';
      else what = 'Higher rank';
      return win(aWins, 'rank', `${what}: ${hi} beat ${lo}.`);
    }
  }

  if (a.topCard !== b.topCard) {
    const aWins = a.topCard > b.topCard;
    const w = aWins ? a : b;
    const l = aWins ? b : a;
    return win(
      aWins,
      'suit',
      `Same ranks — decided by the suit of the highest card: ${topCardText(w)} beats ${topCardText(l)} ` +
        `(${SUIT_SYMBOLS.slice().reverse().join(' > ')}).`,
    );
  }

  if (a.topCardIsJoker !== b.topCardIsJoker) {
    const aWins = !a.topCardIsJoker;
    const real = cardLabel(a.topCard);
    return win(aWins, 'realCard', `Joker-as-${real} vs. the real ${real} — the real card wins.`);
  }

  if (a.highestReal !== b.highestReal) {
    const aWins = a.highestReal > b.highestReal;
    const w = cardLabel(aWins ? a.highestReal : b.highestReal);
    const l = cardLabel(aWins ? b.highestReal : a.highestReal);
    return win(
      aWins,
      'highestReal',
      `Both top cards are Jokers as ${cardLabel(a.topCard)} — the highest real card decides: ${w} beats ${l}.`,
    );
  }

  // Two hands dealt from one deck can never reach this point.
  throw new Error('Hands are identical — impossible with a single deck');
}

export function compareHands(a: readonly Card[], b: readonly Card[]): Comparison {
  return compareEvaluations(evaluateHand(a), evaluateHand(b));
}

function withArticle(name: string): string {
  return /^(One|Two|Three|Four|Five) /.test(name) ? name : `a ${name}`;
}

/** "Pair of Aces", "Two Pair, Kings and Tens", "Full House, Queens over Jacks", ... */
export function describeHand(e: Evaluation): string {
  const g = e.groups;
  switch (e.category) {
    case Category.FiveOfAKind:
      return `Five of a Kind, ${RANK_PLURALS[g[0].rank]}`;
    case Category.RoyalStraightFlush: {
      const suit = e.cards.find((c) => !isJoker(c))!;
      return `Royal Straight Flush (${SUIT_SYMBOLS[suitOf(suit)]})`;
    }
    case Category.FourOfAKind:
      return `Four of a Kind, ${RANK_PLURALS[g[0].rank]}`;
    case Category.RoyalStraight:
      return 'Royal Straight';
    case Category.FullHouse:
      return `Full House, ${RANK_PLURALS[g[0].rank]} over ${RANK_PLURALS[g[1].rank]}`;
    case Category.ThreeOfAKind:
      return `Three of a Kind, ${RANK_PLURALS[g[0].rank]}`;
    case Category.TwoPair:
      return `Two Pair, ${RANK_PLURALS[g[0].rank]} and ${RANK_PLURALS[g[1].rank]}`;
    case Category.OnePair:
      return `Pair of ${RANK_PLURALS[g[0].rank]}`;
    default:
      return `High Card, ${RANK_NAMES[g[0].rank]}`;
  }
}

/** "Joker as A♠" etc, or "" when the hand has no Joker. */
export function describeJoker(e: Evaluation): string {
  if (!e.usesJoker || e.jokerAs === null) return '';
  const r = rankOf(e.jokerAs);
  // Outside flushes the Joker's suit is irrelevant except for tiebreaks, where it counts as ♠.
  const s = e.category === Category.RoyalStraightFlush ? suitOf(e.jokerAs) : SPADES;
  return `Joker as ${cardLabel(makeCard(r, s))}`;
}
