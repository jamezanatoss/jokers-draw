/**
 * Card encoding.
 *
 * A card is a small integer so the AI can work with bitmasks:
 *   0..19  = rank * 4 + suit
 *   20     = Joker
 *   21     = second Joker (only in 2-Joker mode)
 *
 * rank: 0=10, 1=J, 2=Q, 3=K, 4=A   (higher index = higher rank)
 * suit: 0=♣, 1=♦, 2=♥, 3=♠          (higher index = higher suit)
 *
 * Because of this layout, for real cards `a > b` <=> a beats b by rank, then suit.
 */
export type Card = number;
export type Rank = 0 | 1 | 2 | 3 | 4;
export type Suit = 0 | 1 | 2 | 3;

export type JokerCount = 1 | 2;

export const JOKER: Card = 20;
export const JOKER2: Card = 21;
/** Deck size in the default 1-Joker mode. */
export const DECK_SIZE = 21;
/** Highest card id + 1 over all modes (bitmask width). */
export const MAX_CARDS = 22;
export const deckSizeFor = (jokers: JokerCount): number => 20 + jokers;
export const HAND_SIZE = 5;
export const NUM_RANKS = 5;
export const NUM_SUITS = 4;

export const RANK_LABELS = ['10', 'J', 'Q', 'K', 'A'] as const;
export const RANK_NAMES = ['Ten', 'Jack', 'Queen', 'King', 'Ace'] as const;
export const RANK_PLURALS = ['Tens', 'Jacks', 'Queens', 'Kings', 'Aces'] as const;
export const SUIT_SYMBOLS = ['♣', '♦', '♥', '♠'] as const;
export const SUIT_NAMES = ['Clubs', 'Diamonds', 'Hearts', 'Spades'] as const;
export const SPADES: Suit = 3;

export const isJoker = (c: Card): boolean => c >= JOKER;
export const countJokers = (cards: readonly Card[]): number => cards.filter(isJoker).length;
export const rankOf = (c: Card): Rank => (c >> 2) as Rank;
export const suitOf = (c: Card): Suit => (c & 3) as Suit;
export const makeCard = (rank: number, suit: number): Card => rank * 4 + suit;

export function fullDeck(jokers: JokerCount = 1): Card[] {
  return Array.from({ length: deckSizeFor(jokers) }, (_, i) => i);
}

export function cardLabel(c: Card): string {
  if (isJoker(c)) return 'Joker';
  return RANK_LABELS[rankOf(c)] + SUIT_SYMBOLS[suitOf(c)];
}

export function cardName(c: Card): string {
  if (isJoker(c)) return 'the Joker';
  return `${RANK_NAMES[rankOf(c)]} of ${SUIT_NAMES[suitOf(c)]}`;
}

const SUIT_PARSE: Record<string, Suit> = {
  c: 0, '♣': 0, d: 1, '♦': 1, h: 2, '♥': 2, s: 3, '♠': 3,
};
const RANK_PARSE: Record<string, Rank> = { '10': 0, t: 0, j: 1, q: 2, k: 3, a: 4 };

/** Parse "AS", "10h", "T♣", "K♥", "JK"/"Joker", "JK2" (second Joker). Handy for tests. */
export function parseCard(s: string): Card {
  const t = s.trim().toLowerCase();
  if (t === 'jk' || t === 'joker' || t === '*') return JOKER;
  if (t === 'jk2' || t === 'joker2') return JOKER2;
  const suit = SUIT_PARSE[t.slice(-1)];
  const rank = RANK_PARSE[t.slice(0, -1)];
  if (suit === undefined || rank === undefined) throw new Error(`Cannot parse card "${s}"`);
  return makeCard(rank, suit);
}

/** Parse a space-separated list of cards: "AS AH KD 10C JK". */
export function parseCards(s: string): Card[] {
  return s.trim().split(/\s+/).map(parseCard);
}

/** Display order: by rank, then suit; Joker last. */
export function sortCards(cards: readonly Card[]): Card[] {
  return [...cards].sort((a, b) => a - b);
}
