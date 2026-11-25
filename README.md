# Joker's Draw

Two-player draw poker (you vs. an AI, or vs. a friend online) played with a 21-card deck and one wild Joker, or
optionally a 22-card deck with two Jokers. Vite + TypeScript, no UI framework. All card art is plain
CSS; sound effects are synthesized with the Web Audio API.

**Play it:** https://jokers-draw.natipz.workers.dev

```bash
npm install
npm run dev      # app (Vite, http://localhost:5173) + online room server (wrangler dev, :8787)
                 # add ?debug to the URL to see the AI's reasoning in the log
npm test         # engine, betting state machine, AI and online-room tests (Vitest)
npm run build    # type-check (app + server) + production build into dist/ + check-dist
npm run deploy   # build, then wrangler deploy (game + rooms in one Cloudflare Worker)
npm run bench    # optional: long AI-vs-bot benchmarks (not part of npm test)
npm run diagnose # optional: Hard's decision statistics and profit ledger
```

## Rules

**Deck.** 10, J, Q, K, A in four suits (20 cards) plus one Joker, or two Jokers (22 cards) if you
pick that before the match. Ranks A > K > Q > J > 10,
suits ♠ > ♥ > ♦ > ♣. Every hand the full deck is shuffled and each player gets 5 cards. Discarded
cards are out until the next hand. Exchanges draw only from what is left of the deck, and you
can't replace more cards than the deck holds.

**Coins.** Both players start with 12. Each hand both ante 1 automatically. A player bets at most
5 per hand (ante included). The cap is `min(5, coins of either player)`, so a short stack can
always match. Reaching 0 coins loses the match.

**Turn order.** Before the match pick Go first, Go second, or Random (an animated coin flip:
Heads means you go first). In every later hand, the loser of the previous hand acts first.

**Actions.** A player's *bet* is their total for the hand (ante included), at most the cap.
*N* is the opponent's current bet.

| Action | When | Effect |
| --- | --- | --- |
| RAISE | always | Set your total to N+1 or more (≤ cap), then exchange 0–5 cards. |
| BET | responding only | Set your total to N or more (≤ cap), then exchange 0–5 cards. |
| CALL | N < cap | Challenge at an amount you choose, **at least N+1** (so the first CALL of a hand is 2+). |
| DROP | always | Fold. The opponent takes everything bet this hand. |
| ACCEPT | after a CALL | Match the called amount, then showdown. |

- **Acting first** in a hand you can only RAISE, CALL or DROP; there is no BET.
- **BET above N and RAISE** do the same thing, as in the original game. They differ only in
  their minimums.
- **After a CALL** nobody can exchange any more and the amount can't be raised. The opponent may
  only ACCEPT or DROP. CALL doesn't exist when N is already at the cap.
- **Final round:** when a BET or RAISE reaches the cap (5), that player exchanges as usual. The
  opponent then gets exactly one last turn: BET (match the cap) and exchange 0–5 cards, or DROP.
  Then the showdown is automatic. If a player has only 1 coin (cap 1), the whole hand is a final
  round: one turn each, then showdown.
- **Turns alternate** until a CALL or the final round leads to a showdown, or someone drops.
- **Termination:** with an empty deck, BET/RAISE still work but exchange 0 cards. After 6
  exchange rounds in a hand only CALL and DROP remain, so every hand ends.

**Discards (pre-match option).** *Face Up* (default): every discarded card is shown on the table,
both players' piles, in discard order and grouped by exchange round. You see the AI's discards and
the AI sees yours. *Face Down*: only card backs and a count per player are shown. The discard
box is cleared at the start of each hand. The rules screen shows the current table's mode.

**Reveal.** When a hand ends, showdown or DROP, both hands are turned face up with their names and
the result. They stay visible until you press Next Hand (or Enter). After a DROP the panel also says
which hand would have won a showdown.

**Hand ranking (high → low).** Five of a Kind (needs the Joker), Royal Straight Flush, Four of a
Kind, Royal Straight, Full House, Three of a Kind, Two Pair, One Pair. With only five ranks, any
five distinct ranks are always 10-J-Q-K-A, so plain flushes and straights don't exist and **High Card
is impossible**. The tests check this over all 20,349 hands, which is why High Card isn't listed in
the game. The side panel shows each hand with five example cards. On a narrow panel the cards sit
under the name; on a wide one they sit beside it (a CSS container query).

**Joker.** Wild: it becomes the rank and suit that make the best hand. In a tiebreak the Joker itself
never counts as the highest card.

*Joker rule:* if both hands are the **same category** and exactly one of them holds a Joker, the
hand with the Joker loses, whatever the ranks and suits. If both hold a Joker (2-Joker mode), the
normal tiebreak applies.

**Two Jokers.** A player can never hold both Jokers. If you hold one and would receive the other
(on the deal or in an exchange), you get the next card instead, and that Joker goes back into the
remaining deck at a random position. If no other card is left, that draw is skipped and you keep
the card you meant to discard. A Joker you discard no longer counts as held, even within the same
exchange, so you can later receive the other one. The engine stays pure: the random re-insertion
uses a seed stored in the hand state.

**Tiebreaks. There are no ties.**
1. Category.
2. Ranks of the defining groups: the pair; for two pair the higher pair, then the lower; for a
   full house the triple. Kickers never count.
3. Without Jokers: the suit of the highest card in the top defining group (A♠A♣ beats A♥A♦); for
   straights, the highest card. (If only one hand holds a Joker, the Joker rule has already decided.)
4. Both hands hold a Joker (2-Joker mode only): the Joker is ignored and the **highest real card**
   decides: rank first, then suit (♠ > ♥ > ♦ > ♣), then the next-highest real card. Example, both
   Royal Straights: 10♦ J♦ Q♠ K♥ + Joker loses to 10♥ J♥ K♠ A♣ + Joker, because A♣ beats K♥.

The showdown panel names the step that decided the hand. With one Joker, the Joker cases of step 3
and step 4 can never decide a real game, because the Joker rule settles every Joker-vs-natural pair
first. They do come up in 2-Joker mode, and all of them are tested.

## Controls

Click cards to mark them for exchange, then press BET or RAISE. The action panel, top to bottom:

1. **Status and hint:** whose turn it is and how many cards are marked.
2. **"Your bet":** one amount shared by BET, RAISE and CALL. It shows a large total with − / +
   around it, and a line like "AI bet 2 · max 5" under it. It always starts at the minimum legal
   amount (N when BET is possible, otherwise N+1: RAISE and CALL always add at least 1) every turn and hand. The arrow keys change it too.
3. **Buttons:** each shows its real result, with "keep all" / "exchange n" underneath:
   - "BET 2" (only when responding);
   - "RAISE → 3" (uses max(amount, N+1));
   - "CALL 2 · no more exchanges";
   - "DROP · lose 1".

   Buttons that can't be used are greyed, and hovering shows why.
4. **Sound controls.**

On phones the same order appears below the table. Keyboard: <kbd>←</kbd>/<kbd>→</kbd> move between cards and buttons, <kbd>↑</kbd>/<kbd>↓</kbd>
mark/unmark the focused card (or change the raise amount on a button), <kbd>1</kbd>–<kbd>5</kbd> toggle
cards, <kbd>Enter</kbd> press / next hand, <kbd>Esc</kbd> clear marks or close the rules,
<kbd>D</kbd>/<kbd>R</kbd>/<kbd>B</kbd>/<kbd>C</kbd> drop/raise/bet/call (C also accepts or matches),
<kbd>M</kbd> mute/unmute all sound.

## Thai rules (ภาษาไทย)

The Rules screen has a **ไทย / English** toggle; the choice is saved in `localStorage`. Only the
Rules screen changes language. The in-game hand-ranking panel and the rest of the UI stay English.
- **Text:** natural Thai, with action names and hand names in English, e.g. "Full House (ฟูลเฮาส์)".
- **Font:** bundled Noto Sans Thai (`@fontsource`, so it works offline).
- **Illustrations:** the real card component at ~32 px. They show every hand ranking, the Joker
  rule, the suit tiebreak, the sort order (Joker last) and a CALL example with coins.
- **Matching the engine:** all example hands live in `TH_EXAMPLES` (`src/ui/rulesTh.ts`), and
  `tests/rulesTh.test.ts` checks each one against the engine, so the Thai text can't drift from
  the rules.

## Layout

On desktop (wider than 900 px) the whole game fits in the viewport with no page scrolling. Card
and spacing sizes scale with `clamp()` on viewport units. The action buttons, raise amount, exchange
summary and sound controls sit in a panel on the right of the table; rankings and the log are in
the right column (the log scrolls inside its own box). Checked at 1024x768 up to 1920x1080,
including a short 1600x650 window. Between 601 and 900 px the buttons move below the table and the
page scrolls vertically, with no horizontal scroll.

**Phones (600 px wide and below)** get a one-screen layout with no scrolling during play. It also
fits in-app browsers (Messenger, LINE) whose visible height is smaller.
- **Sizing:** it uses `100dvh` and the safe-area insets (`viewport-fit=cover`).
- **Header:** a slim icon row: ♠ rankings, ☰ log, ♪ sound & music, ? rules, ↺ new game.
- **AI row:** name, coins and BET on one line above smaller cards.
- **Middle strip:** deck, LAST n, POT (with bet/max) and a **Discards** chip. With face-up
  discards, tapping the chip shows the cards in a popover.
- **Status line:** last action and, online, the turn timer and the opponent's connection status.
- **Your row:** name, coins, BET and your hand's name above larger cards.
- **Action bar:** pinned to the bottom: your bet − n + on one line, then BET / RAISE / CALL /
  DROP side by side (short sub-text), or NEXT HAND.
- **Hand result:** shown as an overlay over the middle strip, so nothing moves.
- **Sheets:** hand rankings, the table log and the sound settings open as bottom sheets.
- **Taps:** every tap target is at least 44 px.

Checked at 390x844, 390x664 (in-app browser height), 360x740 and 375x667, vs. AI and online.

## Card animation

Hands move in a two-phase "card swipe" (`src/ui/animation.ts`):

1. **Swipe in (right to left):** after the deal or an exchange, the new cards slide in from the
   right edge of the hand one after another and land in their unsorted arrival order. On an
   exchange only the new cards move; kept cards stay where they are. A short pause shows the
   unsorted hand.
2. **Swipe to sort (left to right):** the hand collapses into a tight stack on the left, then fans
   out into sorted order card by card. The Joker always lands last, on the far right.

A quiet swish plays for each phase and a light tick as each card lands. Both hands use the effect,
including the AI's face-down one. To avoid leaking information, the AI's backs collapse into one
exact stack before fanning out, and the backs that leave on an AI exchange are random slots. Card
clicks and action buttons are blocked until the animation ends. A full deal takes 1.2 s; all
timings are constants in `SWIPE`. With `prefers-reduced-motion` both phases are skipped and the
sorted hand appears directly.

The engine keeps each hand in arrival order (dealt order, with drawn cards in the discarded
slots); sorting is purely for display.

## Table display

- **Bets:** each player's bet for the hand is a large "BET n" next to their coins. It turns into a
  red "MAX n" at the cap, and the pot total is shown big in the center.
- **Action banner:** every BET, RAISE, CALL, DROP or ACCEPT shows a short banner in the
  middle of the table for about 0.9 s, e.g. "AI · RAISE +2 → 4". It says who acted and uses a
  color per action. It never blocks clicks.
- **Coins:** coins fly from the player's stack to the pot (ante included), with the coin sound.
- **Deck counter:** the remaining deck is a "LAST nn" box.
- **Discard box:** a framed box with one row per player (AI / YOU). Discarded cards fly from the
  hand into it. Cards overlap as a row fills, so a full row (up to 12) fits without scrolling.

With `prefers-reduced-motion` the banner just appears and disappears, and nothing flies.

## Sound

- **Music:** *Joker's Gambit*, an original loop composed for this game and synthesised live with
  the Web Audio API, with no audio files ([musicScore.ts](src/ui/musicScore.ts) is the score,
  [music.ts](src/ui/music.ts) the synth).
  - **Style:** 108 BPM with swung 16ths, in D minor with jazzy 9th, #11 and altered chords. It has
    a syncopated bass with chromatic approach notes, an FM electric piano, a detuned pulse/saw lead
    with scoops and vibrato, a triangle mallet, noise drums, a small reverb and a dotted-8th echo.
  - **Form:** A1 groove → A2 lead motif → B1 new harmony, half-time and a muted lead → B2 full
    groove with a fill. That's 32 bars, about 71 s, looping seamlessly.

  It is silent on the start screen and plays only during a match, always from the top:
  - **Go first / Go second:** starts right after Deal.
  - **Random:** starts once the coin flip has landed.
  - **Stops and rewinds:** at game over (the win/lose sound plays instead) and when you return to
    the start screen.

  Deal counts as the user gesture browsers require for autoplay. Mute and volume settings still
  apply.
- **Effects:** generated with the Web Audio API, no files: shuffle, card swish and landing tick,
  card flip, select/deselect, exchange, coin clinks (ante/BET/RAISE), CALL, DROP, win, lose, game over, coin
  flip.
- **Controls:** the *Sound* section of the action panel has separate volume sliders and mute
  buttons for Music and Effects. The speaker button in the top bar (or <kbd>M</kbd>) mutes
  everything. Settings, along with difficulty, turn order and Joker count, are saved in
  `localStorage`.

**Your own music.** In the *Sound* section of the action panel:
- **Choosing a file:** **Choose music file…** takes any audio file the browser can play. It replaces
  *Joker's Gambit* vs. the AI and online, for you only (your opponent keeps their own music).
  **Use default music** switches back.
- **Rules:** the same start, stop, rewind, volume and mute rules apply.
- **Privacy:** the file stays on your device. It's kept in this browser's IndexedDB, so it's
  remembered next time, and played from a local object URL. It is never uploaded or sent to the
  room server.
- **Bad files:** non-audio, empty, over 60 MB or unplayable files are rejected with a message, and
  the current music keeps playing.

**Private local track (dev only).** If `local-audio/osiris.mp3` exists, *vs-AI* matches use it
during `npm run dev`. That folder is gitignored and outside `public/`, so the file can never be
built or deployed. In production builds the path doesn't even exist in the code
(`import.meta.env.DEV`). Online matches and every deployed build always use *Joker's Gambit*.
`npm run build` ends with `scripts/check-dist.mjs`, which fails the build if `dist/` contains any
audio file or a reference to the private track.

## Project layout

```
src/engine/   pure rules, no DOM
  cards.ts      card encoding (0..19 = rank*4+suit, 20/21 = Jokers), parsing, labels
  evaluate.ts   hand evaluation, total-order score, compare + tiebreak explanation
  betting.ts    per-hand state machine: newHand / legalActions / applyAction
  match.ts      coins across hands, loser-acts-first, game over, coin flip
  view.ts       per-player view (hides opponent cards; Cheater view adds them)
src/ai/
  tables.ts     lookup tables over 22-bit card masks (one set per Joker mode)
  opponentModel.ts  tendencies + Bayesian range sampling
  ai.ts         decision making (Normal / Hard / Cheater)
  sim.ts        headless match runner + baseline bots
src/ui/       DOM rendering, card-swipe animation (animation.ts), keyboard, sound (sound.ts)
src/online/   browser side of online play
  connection.ts PartySocket wrapper, room codes, per-tab player id
  localize.ts   server view → the table's MatchState, seen from the local player
shared/
  protocol.ts   message types shared by client and server (intents, views, room info)
server/       Cloudflare Worker + Durable Object (wrangler.jsonc, tsconfig.json)
  src/core.ts   room logic (pure, unit-tested): seats, flip, ready steps, validation, views
  src/index.ts  PartyServer `JokerRoom` + Worker routing
local-audio/  (gitignored) private music for local vs-AI play only, never built or deployed
tests/        Vitest suites
scripts/      benchmarks (npm run bench)
```

## Run, deploy, invite a friend

**Run locally.** `npm install`, then `npm run dev`, and open http://localhost:5173. That one
command starts Vite (the game) and `wrangler dev` (the room server, port 8787). Vite forwards
`/parties/*` WebSockets to wrangler, so local play needs no Cloudflare account. For online play,
open a second browser window (or a private window) and join with the code. To use a phone on the
same Wi-Fi, run `npx vite --host` and `npm run dev:worker` in two terminals, then open the printed
network URL on the phone.

**Deploy (Cloudflare Workers).** The game's static files and the online rooms live in **one Worker**
([server/wrangler.jsonc](server/wrangler.jsonc)):
- **Static files:** `assets` uploads `dist/`.
- **Routing:** `run_worker_first` sends `/parties/*` (WebSockets) and `/health` to the Worker
  code; everything else is served as a static file.
- **Rooms:** the Durable Object `JokerRoom`.

```bash
npx wrangler login   # once per machine: opens the browser; the token stays in your user profile
npm run deploy       # build + check-dist + wrangler deploy → https://jokers-draw.<subdomain>.workers.dev
```

**Why Workers rather than Vercel:**
- **The rooms need Cloudflare anyway:** they are Durable Objects, and Vercel has no equivalent
  for long-lived WebSocket rooms. Splitting would mean two deployments plus a cross-origin socket.
- **One origin:** with Workers static assets, `npm run deploy` publishes both together, and the
  page and its WebSockets share one origin, so there's no CORS and no extra URL to configure.

**WebSocket URL.** By default the client connects to its own origin, which is correct both
locally (via the Vite proxy) and when deployed. If you ever host the page somewhere else, set
`VITE_PARTY_URL=https://jokers-draw.<subdomain>.workers.dev` at build time (see
[.env.example](.env.example)).

**Invite a friend.**
1. Open the site → **Play Online** → choose the table → **Create room**.
2. Send the link the lobby shows (`…/?room=CODE`), or just the 5-character code.
3. Your friend opens the link (or types the code under **Join a room**) on any device. The match
   starts when both of you are connected.
4. If either of you drops or reloads, opening the same link (or **Rejoin** on the start screen)
   gets you back into your seat.

## Online play

Start screen → **Play Online**. The host picks the table (turn order for the first hand, Jokers,
discards, turn timer) and presses **Create room**. That gives a 5-character room code and a share link
(`?room=CODE`). The friend opens the link or types the code under **Join a room**. The match
starts when both are connected. With Random order the *server* flips the coin (Heads: the host
goes first), both players see the same flip, and the first hand is dealt when both press Play.
After each hand both press Next. With a turn timer, the next hand also starts by itself after
30 s. After game over both can press **Rematch**: a new match with the same settings starts when
both agree. **Leave room** goes back to the start screen. During a match it asks first, because
leaving forfeits.

**Local:** `npm run dev` runs Vite and `wrangler dev` together. Vite forwards `/parties/*`
WebSockets to the worker, so the page always talks to its own origin. Open two browser windows,
or a normal and a private one, and play. No Cloudflare login is needed locally. Logging in
(`npx wrangler login`) is only needed to deploy, and no token is stored in the repo. To try it on
a phone on the same network, run `npx vite --host` instead of `npm run dev:app`.

**Architecture.** There is one Durable Object (PartyServer `JokerRoom`) per room code, at
`/parties/joker-room/CODE`. The server is authoritative:
- **Engine:** it imports the same engine as the client (`src/engine`), so no rules are duplicated.
- **Dealing:** it shuffles with crypto-seeded randomness and deals.
- **Moves:** it validates every move and decides showdowns.
- **Persistence:** room state is saved to Durable Object storage after every change, so it
  survives restarts.
- **Clocks:** every clock runs on the server as a deadline, driven by a Durable Object alarm, so
  a hidden or sleeping tab cannot stall or cheat it:
  - **Turn timer:** 15, 30 or 60 s, or off (host's choice). Running out means an automatic DROP,
    shown with a "TIME'S UP" banner on both screens. The clock starts after each move's card
    animation (a 0.5–2 s grace period), so animations never use up a turn. It pauses while the
    player to act is disconnected.
  - **Forfeit:** a player disconnected for more than **60 s** during a match forfeits it, while
    the other player is still there.
  - **Room expiry:** a room with **nobody connected for 10 minutes** is deleted. A running or
    paused match stays alive as long as someone is connected.

**Protocol** ([shared/protocol.ts](shared/protocol.ts)). Clients send only intents:
- `{ action: 'raise', amount: 3, exchange: [cardIds] }`;
- `bet` / `call` with an optional amount;
- `accept` and `drop`;
- `{ type: 'ready' }` for Play, Next and Rematch.

BET/RAISE and their exchange are one intent and are applied atomically. A bad exchange rejects
the whole move, and illegal or out-of-turn intents get an error message.

The server answers every change with a per-player view:
- your hand, the opponent's card **count**, and the deck **count** (no order, no seed);
- your discards, plus the opponent's discards only when the table is face up;
- bets, stacks, cap, phase and your legal actions.

The opponent's cards are sent only once the hand is over (`reveal`). The client turns this view
into the same `MatchState` the table already renders. Unknown cards become negative placeholder
ids, so the existing UI, betting previews and animations work unchanged.

**Reconnecting.**
- **Two identities:**
  - **Player id** (`sessionStorage`, per tab): a reload or network drop rejoins the same seat with
    the current state. Two windows of the same browser count as two players.
  - **Seat token** (`localStorage`, per room, secret, only ever sent to its owner): a closed tab
    can reclaim its seat. Opening the link again, or **Rejoin** on the start screen, sends the
    token. The server accepts it only while no other tab holds that seat, so the token can't take
    over a player who is still there.
- **What the other player sees:** "Opponent disconnected — they forfeit in 47 s" with a live
  countdown, and an *offline* badge.
- **Dead connections:** the client pings every 4 s. The server treats a connection silent for 15 s
  as gone, and the client reopens a socket that stopped answering.
- **Connection indicator:** in the top-right corner, a dot and the ping in ms.
- **Background tabs:** a tab in the background catches up in one step when it comes back, with no
  replay of animations it missed.
- **Third person:** gets "Room is full".

**Tests** (`tests/online.test.ts`):
- **Illegal moves:** 20+ illegal or malformed intents are rejected (wrong turn, BET on the first
  action, out-of-range amounts, CALL ≤ N, ACCEPT without a CALL, CALL + exchange, foreign or
  duplicate cards, final-round limits) and the state stays unchanged.
- **Hidden information, by content:** in every Joker and discard mode, no message ever contains
  an opponent card, a deck card or a face-down discard before the reveal.
- **Hidden information, by comparison:** with the opponent's cards and the deck permuted, every
  message a player receives is byte-for-byte identical.
- **Full matches:** 15 complete matches play to game over in all settings, then a rematch.
- **Client agreement:** the client's view conversion offers exactly the server's legal actions
  at every step.
- **Robustness, on a fake clock:**
  - **Reconnect:** a reload keeps the seat; a closed tab reclaims it with its token; a token can't
    take a connected seat; tokens never reach the other player.
  - **Turn timer:** it runs out into a DROP with the grace period, pauses while the player is away,
    and can be turned off; the next hand starts by itself.
  - **Forfeit:** after 60 s away, but not while both players are away; leaving forfeits too.
  - **Rest:** rematch with the same settings, a full room, 10-minute expiry, and clocks surviving a
    restart.

### Betting state machine

`HandState.phase` is one of `turn --BET/RAISE--> exchange → turn …`,
`turn --CALL--> callResponse --ACCEPT/DROP--> over`, and `turn --DROP--> over`.
`legalActions(state)` returns exactly the allowed moves, with the legal total range for BET, RAISE
and CALL. BET is null on the first action and once `MAX_EXCHANGE_ROUNDS` (6) is used up.
`applyAction` validates against it and throws `IllegalActionError` otherwise. Everything is
immutable. A property test plays 4,000 random, mostly passive hands in both Joker modes. It checks
coin and card conservation, bet caps, that nobody ever holds two Jokers, and that every hand ends
within the round cap.

### Evaluation

`evaluateHand` tries all 20 rank/suit substitutions for the Joker and keeps the best. Each hand
gets an integer `score` that folds in, from most to least significant:
- category;
- the Joker rule (a "no Joker" bit right below the category);
- the group ranks;
- the last step: for hands without a Joker, the highest card of the top group (its suit); for
  hands with a Joker, the four real cards from highest to lowest (base 20), which is the
  both-Joker rule.

Comparing scores therefore gives the full rules as a total order. The tests check this
exhaustively for both decks: no two hands that can be dealt together share a score, every Joker
hand ranks below every natural hand of its category, and `compareEvaluations` agrees with the
score.

## AI design

The AI only ever receives a `PlayerView`, so it cannot see your cards (a test checks that its
decisions don't depend on your hidden hand). Cheater mode is the one exception, and the table
shows a visible badge while it's on.

**Lookup tables** (built once per Joker mode, ~0.2 s): the score of every legal 5-card hand
indexed by bitmask (stored as a dense rank), its percentile among all hands of that deck, and the
*keep value* of every 0–5 card subset. The keep value is the expected percentile after drawing the
rest, never counting completions that would hold both Jokers. Because the tables come from the
engine's score, the Joker rule is built into everything the AI evaluates. For example, it knows
that trips made with the Joker lose to any natural trips.

**Opponent range.** Each decision draws ~1,500 importance-weighted samples of your hand. Each
sample replays the hand from the AI's point of view. It deals you 5 random cards from the cards
the AI has never seen. At each of your exchanges of *k* cards it keeps the best 5-k cards (with
noise) and draws *k*. The sample's weight is multiplied by the likelihood of what you actually did:
- the number of cards you exchanged (a softmax over keep values, with a floor for snowing and trapping);
- your raise sizes (bigger raises make strong hands more likely);
- CALL (a bigger CALL above the AI's bet signals a stronger hand) and ACCEPT.

Card removal is exact: the remaining unseen cards in each sample *are* the deck.

**Discards and fairness.** With *Face Up* discards the AI uses exactly what you can see. Your
thrown cards are removed from its unknown cards. Each sampled replay of your hand must have held
those cards and thrown them, weighted by how sensible it is to keep the rest. With *Face Down*
discards neither side learns the cards; the AI only sees how many you threw, and a test checks
its decisions don't depend on which cards they were. In 2-Joker mode
the sampled deals and draws follow the one-Joker rule, and so do the AI's simulated draws (a
refused Joker is skipped and stays in the deck).

**Tendencies across hands.** Beta estimates of how often you fold to raises, fold to CALLs, fold
after calling, and how often your aggression turns out to be a bluff. Hands are now revealed
after every hand, so it also learns from hands that ended in a DROP. They
decay slowly, so the AI follows a change in your style.

**Exchange.** For all 32 discard subsets the AI plays out its draw against every sample's own deck
order. It also simulates your best redraw on your next turn. It picks the subset with the highest
win probability. This produces sound, sometimes surprising plays: against a stand-pat range it
will break a Joker Royal Straight (which loses to any real one) to draw a real 10.

**Betting: everything is expected value.** Every legal action gets an EV in coins:
- **DROP** loses your bet.
- **CALL** is evaluated for every legal amount. The opponent can only ACCEPT or DROP: the AI
  wins N if they drop, else it's a showdown at the called amount with *current* cards. CALL ends
  drawing for both players.
- **BET/RAISE** combine fold equity with the win probability after the AI's own best exchange
  *and* the opponent's best redraw (they'll get another turn). Reaching the cap starts the final
  round, which the model covers too: one opponent response, then showdown.
- **Final round:** BET the cap with the best exchange, or DROP, by EV. As final responder the AI
  knows nobody draws after it.

A variance term reflects the coin stacks: risk-averse when ahead or short-stacked, risk-seeking
when behind. Choices go through a low-temperature softmax, so near-equal options get mixed and
there's no fixed pattern to exploit. Decisions take about 5–150 ms.

### Hard: a disciplined gambler

A first diagnosis (600+ simulated hands) showed the old Hard locking hands cheaply. About half of
its CALLs were the minimum size, roughly 40–70% were made on the dealt hand, and 23–37% of all
CALLs were minimum-size with less than 60% equity. Hard now adds a discipline layer on top of the
EVs.

- **Hand tiers through equity.** Win equity against the *inferred* range decides what Hard does:
  - *Monsters* (Full House and up, or ~85%+ equity) build the pot: big BET/RAISE, CALL big when
    the opponent is likely drawing, slow-play sometimes.
  - *Strong* hands (Trips, good Two Pair) value-bet and CALL at sizes the player's range still
    accepts.
  - *Medium* hands draw to improve instead of calling.
  - *Weak* hands exchange aggressively or DROP when the price is wrong.
- **CALL is a commitment.** A value CALL needs equity ≥ **0.68**; that threshold was tuned by
  simulation, trying 0.60, 0.68 and 0.76. It must also be at least as good as drawing on, and
  minimum-size (+1) CALLs with less than ~80% equity are gone. Because a CALL also stops *your*
  draw, Hard calls when it is ahead now and your redraw is the threat.
- **Learned from revealed hands.** Every hand is revealed, and nothing changes after a CALL or a
  push to the cap, so several of your habits can be measured exactly:
  - the strength you CALL with;
  - your accept/fold threshold against Hard's CALLs;
  - how strong you really are when you push to 5.

  Fold rates are also learned per bet size (+1 vs. +2 or more). A big or early CALL (before you
  have drawn) reads as stronger.
- **Bluffs are rare and purposeful.** Hard bluffs only with weak hands, and sizes them like value:
  the biggest move, never a 1-coin probe. It bluffs more when:
  - your last exchange was big (you look weak);
  - you are short of coins;
  - you actually fold.

  It bluffs less when you stand pat.
- **Stack-aware.** Hard pressures a short stack and avoids big coin-flips when it is short itself.
- **Discards.** With Face Up discards your thrown cards condition the range: each sampled replay
  must hold and throw exactly them.

**Difficulties.**
- **Normal:** 250 unweighted samples, static keep-table exchanges, no learning, no discipline
  layer, higher temperature and occasional mistakes. It is meant to be beatable.
- **Hard** (default): everything above.
- **Cheater:** one exact sample, your real hand and the real deck order, through the same EV
  machinery.

### Benchmarks

`npm run bench`: 200 matches per pairing, seats alternated, fixed seeds, win rate with 95% Wilson
interval. "Before" is Hard with the discipline layer switched off (the previous decision model,
same rules). `npm run diagnose` prints Hard's action mix, CALL sizes, hand strength at its CALLs
and a profit ledger by how hands ended.

| Pairing | 1 Joker · face down | 2 Jokers · face down | 1 Joker · face up | 2 Jokers · face up |
| --- | --- | --- | --- | --- |
| Hard vs. heuristic bot | 77.5% [71–83] | 75.0% [69–80] | 81.0% [75–86] | 78.5% [72–84] |
| *before* | 79.5% [73–85] | 72.5% [66–78] | 83.0% [77–88] | 73.0% [66–79] |
| Hard vs. Normal | 73.5% [67–79] | 73.0% [66–79] | 68.5% [62–75] | 71.5% [65–77] |
| *before* | 76.0% [70–81] | 63.0% [56–69] | 69.5% [63–75] | 70.5% [64–76] |
| Hard vs. random bot | 98.5% | 98.0% | – | – |
| Normal vs. heuristic bot | 46.0% [39–53] | 46.0% [39–53] | – | – |
| Cheater vs. Hard | 99.5% | 100% | – | – |

What Hard's CALLs look like (same runs):

| | CALLs per hand | Mean equity at CALL | Cheap CALLs (+1, equity < 0.60) |
| --- | --- | --- | --- |
| Before | 0.15–0.28 | 0.69–0.79 | 27–35% (1 Joker), 6–8% (2 Jokers) |
| After | 0.09–0.22 | 0.83–0.86 | 0–2% |

The slowest Hard decision on an idle machine was 85 ms. It reached up to ~500 ms only while four
benchmark processes and a browser shared the CPU.

**How Hard earns its coins** (`npm run diagnose`, 812 hands vs. the heuristic bot): pushing to the
cap and winning the final round is its biggest earner (+2.68 coins per such hand), then value
CALLs (+2.38). The losses are folds, which the ledger shows are mostly right: against the bot's
CALLs it folded a winning hand once in 39 folds.

