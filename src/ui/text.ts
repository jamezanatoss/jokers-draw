import type { TieBreak } from '../engine';

export const TITLE = "Joker's Draw";

export const RANKINGS: { name: string; example: string; note: string }[] = [
  { name: 'Five of a Kind', example: 'A♠ A♥ A♦ A♣ ★', note: 'Needs a Joker' },
  { name: 'Royal Straight Flush', example: '10♥ J♥ Q♥ K♥ A♥', note: '10 to A, one suit' },
  { name: 'Four of a Kind', example: 'Q♠ Q♥ Q♦ Q♣ 10♠', note: '' },
  { name: 'Royal Straight', example: '10♣ J♦ Q♠ K♥ A♣', note: '10 to A, mixed suits' },
  { name: 'Full House', example: 'K♠ K♦ K♣ J♥ J♠', note: 'Compared by the triple' },
  { name: 'Three of a Kind', example: 'J♠ J♥ J♦ A♣ 10♥', note: '' },
  { name: 'Two Pair', example: 'A♦ A♣ 10♠ 10♥ K♦', note: 'Higher pair, then lower' },
  { name: 'One Pair', example: 'K♠ K♥ A♦ Q♣ 10♠', note: 'Kickers never count' },
];
// No "High Card": with only five ranks, five different ranks are always 10-J-Q-K-A (a straight).

export const TIEBREAK_LABEL: Record<TieBreak, string> = {
  category: 'Hand rank',
  rank: 'Rank of the defining group',
  suit: 'Suit of the highest card',
  jokerRule: 'Joker rule (same hand — the one with the Joker loses)',
  highestReal: 'Highest real card (both hands hold a Joker)',
};

export const RULES_HTML = `
<h2>Rules</h2>
<section>
  <h3>The deck</h3>
  <p>21 cards: 10, J, Q, K, A in four suits, plus one <b>Joker</b> (22 cards with the optional second Joker).
  Ranks: <b>A &gt; K &gt; Q &gt; J &gt; 10</b>. Suits: <b>♠ &gt; ♥ &gt; ♦ &gt; ♣</b>.</p>
  <p>Every hand the full deck is shuffled and each player gets 5 cards. Discarded cards stay out
  for the rest of the hand — new cards come only from what is left of the deck.</p>
</section>
<section>
  <h3>Discards</h3>
  <p>Chosen before the match. <b>Face up</b>: every discarded card is shown on the table, in order and grouped by
  exchange round — you see the AI's discards and the AI sees yours. <b>Face down</b>: only the number of cards each
  player discarded is shown, for both sides. The discard box is cleared at the start of every hand.</p>
</section>
<section>
  <h3>Coins</h3>
  <p>Both players start with <b>12 coins</b>; the first to reach 0 loses the match.
  Each hand both players ante 1 coin automatically. A player can bet at most <b>5 coins per hand</b>
  (ante included) — less if either player owns fewer coins.</p>
</section>
<section>
  <h3>Turn order</h3>
  <p>Before the match choose to go first, second, or flip a coin (Heads: you go first).
  After that, the <b>loser of the previous hand acts first</b>.</p>
</section>
<section>
  <h3>Actions</h3>
  <p>Your <b>bet</b> is your total for the hand (ante included), at most 5. <b>N</b> is your opponent's bet.
  One "Your bet" amount drives BET, RAISE and CALL; it starts at the minimum every turn
  (RAISE and CALL always add at least 1).</p>
  <dl>
    <dt>Acting first</dt><dd>Only <b>RAISE</b>, <b>CALL</b> or <b>DROP</b> — there is no BET.</dd>
    <dt>BET</dt><dd>Responding only: set your bet to N or more, then exchange 0–5 cards.</dd>
    <dt>RAISE</dt><dd>Set your bet to N+1 or more, then exchange 0–5 cards. (BET above N and RAISE
      do the same thing — as in the original game.)</dd>
    <dt>CALL</dt><dd>Challenge with your current cards at an amount you choose: <b>at least N+1</b> (so the
      first CALL of a hand is 2 or more). Not possible when N is already 5. After a CALL
      <b>nobody exchanges any more</b> and the amount <b>cannot be raised</b>: your opponent may only
      <b>ACCEPT</b> (match it → showdown) or <b>DROP</b>.</dd>
    <dt>DROP</dt><dd>Fold. Your opponent takes everything bet this hand.</dd>
  </dl>
  <p><b>Final round:</b> when a BET or RAISE reaches the maximum (5), that player exchanges as usual and the
  opponent gets <b>one last turn</b>: BET 5 (match) and exchange 0–5 cards, or DROP. Then the showdown is
  automatic. (If a player has only 1 coin, the whole hand is a final round: one turn each, then showdown.)</p>
  <p>Turns alternate — there can be several exchange rounds — until a CALL or the final round leads to a
  showdown, or someone drops. With an empty deck BET/RAISE still work but exchange nothing. After 6 exchange
  rounds in a hand only CALL and DROP remain, so every hand ends.</p>
  <p>When a hand ends — showdown or DROP — both hands are turned face up.</p>
</section>
<section>
  <h3>The Joker</h3>
  <p>The Joker is wild: it becomes whatever rank and suit makes your best hand. In a tiebreak the Joker
  itself never counts as the highest card.</p>
  <p><b>Joker rule:</b> if both hands are the <b>same category</b> and only one of them holds a Joker,
  the hand <b>with the Joker loses</b> — whatever the ranks and suits. If both hold a Joker, the normal
  tiebreak applies.</p>
  <p><b>Two Jokers (optional):</b> a player can never hold both. If you already hold a Joker and would receive
  the other one (deal or exchange), it goes back into the deck at a random position and you get the next card
  instead; if no other card is left, that draw is skipped and you keep the card. Once you discard your Joker you
  may receive the other one later.</p>
</section>
<section>
  <h3>Breaking ties — there are no ties</h3>
  <ol>
    <li>Compare the hand category.</li>
    <li>Compare the ranks of the defining groups (pair of A beats pair of K; two pair compares the higher pair,
      then the lower; a full house compares the triple). Kickers never count.</li>
    <li>Still equal? The suit of the highest card in the top group decides (A♠A♣ beats A♥A♦).</li>
    <li>Both hands hold a Joker (2-Joker mode)? After step 2 the Joker is ignored: the <b>highest real card</b>
      decides — rank first, then suit (♠ &gt; ♥ &gt; ♦ &gt; ♣), then the next-highest real card. Example, both Royal
      Straights: 10♦ J♦ Q♠ K♥ + Joker loses to 10♥ J♥ K♠ A♣ + Joker, because A♣ beats K♥.</li>
  </ol>
</section>
<section>
  <h3>Keyboard</h3>
  <p><kbd>←</kbd> <kbd>→</kbd> move between cards and buttons · <kbd>↑</kbd> mark a card for exchange,
  <kbd>↓</kbd> unmark (elsewhere: change "Your bet") · <kbd>Enter</kbd> press · <kbd>Esc</kbd> clear marks / close ·
  <kbd>1</kbd>–<kbd>5</kbd> toggle a card · <kbd>D</kbd> drop · <kbd>R</kbd> raise · <kbd>B</kbd> bet ·
  <kbd>C</kbd> call / accept · <kbd>M</kbd> mute all sound</p>
</section>
`;
