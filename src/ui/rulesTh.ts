/**
 * Thai Rules screen (with small card illustrations). The in-game hand-ranking panel is English only.
 *
 * Every example hand shown here lives in TH_EXAMPLES, and tests/rulesTh.test.ts checks each one
 * against the real engine, so the Thai text can't drift from the rules.
 */
import { type Card, MAX_EXCHANGE_ROUNDS, parseCards } from '../engine';
import { sortedDisplay } from './animation';
import { cardFace } from './cardView';

export type RulesLang = 'en' | 'th';

/** Example hands used in the Thai rules (card notation as in parseCards). */
export const TH_EXAMPLES = {
  rankings: [
    { name: 'Five of a Kind', th: 'ไพ่ห้าใบเหมือนกัน', hand: 'AS AH AD AC JK', note: 'ต้องใช้ Joker เท่านั้น' },
    { name: 'Royal Straight Flush', th: 'รอยัลสเตรทฟลัช', hand: '10H JH QH KH AH', note: '10 ถึง A ดอกเดียวกัน' },
    { name: 'Four of a Kind', th: 'โฟร์การ์ด', hand: 'QS QH QD QC 10S', note: 'สี่ใบเลขเดียวกัน' },
    { name: 'Royal Straight', th: 'สเตรท 10 ถึง A', hand: '10C JD QS KH AC', note: '10 ถึง A คละดอก' },
    { name: 'Full House', th: 'ฟูลเฮาส์', hand: 'KS KD KC JH JS', note: 'ตอง + คู่ (ดูที่ตอง)' },
    { name: 'Three of a Kind', th: 'ตอง', hand: 'JS JH JD AC 10H', note: 'สามใบเลขเดียวกัน' },
    { name: 'Two Pair', th: 'สองคู่', hand: 'AD AC 10S 10H KD', note: 'ดูคู่สูงก่อน แล้วคู่ต่ำ' },
    { name: 'One Pair', th: 'หนึ่งคู่', hand: 'KS KH AD QC 10S', note: 'ไพ่ประกอบ (kicker) ไม่นับ' },
  ],
  /** Joker rule: same category (Three of a Kind), only one side holds a Joker → that side loses. */
  joker: { withJoker: 'AH AD JK QC 10C', natural: 'KS KH KD JC 10D' },
  /** Suit tiebreak: same pair rank → the side holding A♠ wins. */
  suit: { spade: 'AS AC KH QH JH', heart: 'AH AD KS QS JS' },
  /** Both hands hold a Joker (2-Joker mode): the highest REAL card decides (A♣ beats K♥). */
  bothJoker: { lose: '10D JD QS KH JK', win: '10H JH KS AC JK2' },
  /** Display order: unsorted → sorted. */
  sort: { unsorted: 'JK AS 10H KD 10C', sorted: '10C 10H KD AS JK' },
  /** CALL example: AI raises to 2, you CALL 3 (at least +1), AI may only ACCEPT (3) or DROP. */
  call: { aiRaise: 2, youCall: 3 },
  /** Final round example: AI raises to the cap (5); you get one turn — BET 5 + exchange, or DROP. */
  final: { aiRaise: 5 },
} as const;


/** Small inline cards (the real card component at ~32 px). `sort` shows them in display order. */
export function xsCards(spec: string, sort = true): string {
  const cards: Card[] = parseCards(spec);
  const shown = sort ? sortedDisplay(cards) : cards;
  return `<span class="xs-hand">${shown.map((c) => cardFace(c, { cls: 'card-xs' })).join('')}</span>`;
}

const coins = (n: number) => `<span class="xs-coins" aria-label="${n} เหรียญ">${'<span class="coin"></span>'.repeat(n)}<b>${n}</b></span>`;

/** The Thai Rules screen. `modeLine` describes the current table settings. */
export function rulesHtmlTh(modeLine: string): string {
  const E = TH_EXAMPLES;
  const ranks = E.rankings
    .map(
      (r, i) => `<li><span class="rk-num">${i + 1}</span>
        <div class="th-rank"><b>${r.name}</b> <span>(${r.th})</span><small>${r.note}</small></div>
        ${xsCards(r.hand)}</li>`,
    )
    .join('');
  return `
<h2>กติกา</h2>
${modeLine}
<section>
  <h3>ภาพรวม</h3>
  <p>โป๊กเกอร์แบบเปลี่ยนไพ่สำหรับ 2 คน — คุณเล่นกับ AI ใช้ไพ่เพียง 21 ใบ: 10 J Q K A สี่ดอก และ Joker 1 ใบ
  ทั้งสองฝ่ายเริ่มด้วย <b>12 เหรียญ</b> ใครเหรียญหมดก่อนเป็นฝ่ายแพ้</p>
</section>

<section>
  <h3>ไพ่และเหรียญ</h3>
  <ul>
    <li>ลำดับเลข: <b>A &gt; K &gt; Q &gt; J &gt; 10</b> · ลำดับดอก: <b>♠ &gt; ♥ &gt; ♦ &gt; ♣</b></li>
    <li>ทุกตาสับไพ่ใหม่ แจกคนละ 5 ใบ ไพ่ที่ทิ้งแล้วออกจากเกมจนจบตานั้น — จั่วได้จากกองที่เหลือเท่านั้น</li>
    <li>ทุกตาลงเหรียญอัตโนมัติคนละ 1 (ante) และเดิมพันรวมในหนึ่งตาได้ไม่เกิน <b>5</b>
      (น้อยกว่านั้นถ้ามีฝ่ายใดเหรียญไม่ถึง 5)</li>
    <li>ไพ่ในมือเรียงให้อัตโนมัติ: 10 J Q K A ดอกต่ำอยู่ซ้าย และ <b>Joker อยู่ขวาสุดเสมอ</b>
      <div class="th-example">${xsCards(E.sort.unsorted, false)} <span class="arrow">→</span> ${xsCards(E.sort.sorted, false)}</div></li>
  </ul>
</section>

<section>
  <h3>ลำดับการเล่น</h3>
  <ul>
    <li>ตาแรกเลือกได้ว่าจะเล่นก่อน เล่นหลัง หรือสุ่ม (โยนเหรียญ: หัว = คุณเล่นก่อน)</li>
    <li>ตาต่อ ๆ ไป <b>ฝ่ายที่แพ้ตาก่อนได้เล่นก่อน</b></li>
    <li>ผลัดกันเล่น เปลี่ยนไพ่ได้หลายรอบ จนกว่าจะมีคน CALL แล้วเปิดไพ่ หรือมีคน DROP</li>
    <li>จบตาแล้ว (ทั้งเปิดไพ่และ DROP) จะเปิดไพ่ทั้งสองฝ่ายให้ดูเสมอ</li>
    <li>ถ้ากองไพ่หมด BET/RAISE ยังกดได้ แต่จะเปลี่ยนไพ่ไม่ได้ · ครบ ${MAX_EXCHANGE_ROUNDS} รอบเปลี่ยนไพ่ในตาเดียว
      จะเหลือแค่ CALL กับ DROP — ทุกตาจึงจบเสมอ</li>
    <li><b>รอบสุดท้าย (FINAL ROUND):</b> ถ้ามีคน BET หรือ RAISE จนถึง 5 (เพดาน) คนนั้นเปลี่ยนไพ่ตามปกติ
      แล้วอีกฝ่ายได้<b>อีกตาเดียว</b>: BET 5 (ลงให้เท่ากัน) แล้วเปลี่ยนไพ่ 0–5 ใบ หรือ DROP — จากนั้นเปิดไพ่อัตโนมัติ
      (ถ้ามีฝ่ายใดเหลือเหรียญ 1 เหรียญ ทั้งตาจะเป็นรอบสุดท้าย: ได้คนละตา แล้วเปิดไพ่)</li>
  </ul>
</section>

<section>
  <h3>คำสั่ง (DROP / RAISE / BET / CALL)</h3>
  <p>"เดิมพัน" คือเหรียญรวมที่คุณลงในตานี้ (รวม ante แล้ว) · <b>N</b> คือเดิมพันของอีกฝ่าย
  ช่อง <b>Your bet</b> ใช้ร่วมกันทั้ง BET, RAISE และ CALL และจะเริ่มที่ค่าต่ำสุดทุกครั้งที่ถึงตาคุณ</p>
  <dl>
    <dt>เล่นก่อนในตานั้น</dt><dd>เลือกได้แค่ <b>RAISE</b>, <b>CALL</b> หรือ <b>DROP</b> — ไม่มี BET</dd>
    <dt>BET</dt><dd>(เฉพาะตอนตอบ) ตั้งเดิมพันเป็น N หรือมากกว่า แล้วเปลี่ยนไพ่ 0–5 ใบ</dd>
    <dt>RAISE</dt><dd>ตั้งเดิมพันเป็น N+1 ขึ้นไป แล้วเปลี่ยนไพ่ 0–5 ใบ (BET เกิน N ให้ผลเหมือน RAISE — ตามเกมต้นฉบับ)</dd>
    <dt>CALL</dt><dd>ท้าเปิดไพ่ด้วยไพ่ที่ถืออยู่ เลือกจำนวนได้เอง แต่ต้อง<b>มากกว่า N อย่างน้อย 1</b>
      (เช่น เพิ่งลง ante คนละ 1 → CALL ได้ตั้งแต่ 2) และ CALL ไม่ได้ถ้าอีกฝ่ายลงถึง 5 แล้ว
      หลัง CALL <b>ไม่มีใครเปลี่ยนไพ่ได้อีก</b> และ<b>ขึ้นเงินต่อไม่ได้</b> อีกฝ่ายทำได้แค่ <b>ACCEPT</b>
      (ลงให้เท่ากันแล้วเปิดไพ่) หรือ <b>DROP</b></dd>
    <dt>DROP</dt><dd>หมอบ — อีกฝ่ายได้เหรียญทั้งหมดที่ลงในตานั้น</dd>
  </dl>
  <div class="th-flow" aria-label="ตัวอย่าง CALL">
    <div class="step"><span class="who ai">AI</span> RAISE → ${coins(E.call.aiRaise)} <small>แล้วเปลี่ยนไพ่</small></div>
    <div class="step"><span class="who you">คุณ</span> CALL ${coins(E.call.youCall)} <small>🔒 ล็อก: ห้ามเปลี่ยนไพ่ ห้ามขึ้นเงิน</small></div>
    <div class="step"><span class="who ai">AI</span> <b>ACCEPT</b> ลงเพิ่มเป็น ${coins(E.call.youCall)} → เปิดไพ่
      <span class="or">หรือ</span> <b>DROP</b> → คุณได้เหรียญ ${E.call.aiRaise} ของ AI</div>
  </div>
  <div class="th-flow final" aria-label="ตัวอย่างรอบสุดท้าย">
    <div class="step"><span class="who ai">AI</span> RAISE → ${coins(E.final.aiRaise)} <small>ถึงเพดาน แล้วเปลี่ยนไพ่</small>
      <span class="final-flag">FINAL ROUND</span></div>
    <div class="step"><span class="who you">คุณ</span> <b>BET ${E.final.aiRaise}</b> + เปลี่ยนไพ่ 0–5 ใบ
      <span class="or">หรือ</span> <b>DROP</b> <small>(ตาเดียวเท่านั้น)</small></div>
    <div class="step"><span class="who">→</span> เปิดไพ่อัตโนมัติ</div>
  </div>
</section>

<section>
  <h3>ลำดับมือไพ่ (สูง → ต่ำ)</h3>
  <ol class="th-ranks">${ranks}</ol>
  <p class="muted">ไม่มี Flush หรือ Straight แบบธรรมดา เพราะมีเลขแค่ 5 ตัว — ไพ่ 5 เลขไม่ซ้ำกันจึงเป็น 10 ถึง A เสมอ</p>
</section>

<section>
  <h3>กฎ Joker</h3>
  <ul>
    <li>Joker เป็นไพ่ใบไหนก็ได้ที่ทำให้มือดีที่สุด แต่เวลาตัดสินมือที่เท่ากัน <b>Joker ไม่นับเป็นไพ่ใบสูงสุด</b></li>
    <li><b>กฎสำคัญ:</b> ถ้ามือเป็นประเภทเดียวกัน และมี Joker อยู่ฝ่ายเดียว — <b>ฝ่ายที่มี Joker แพ้เสมอ</b>
      ไม่ว่าเลขหรือดอกจะเป็นอะไร
      <div class="th-example">${xsCards(E.joker.withJoker)} <span class="muted">ตอง A (มี Joker)</span>
        <span class="vs">vs</span> ${xsCards(E.joker.natural)} <span class="muted">ตอง K ไพ่จริง</span>
        <span class="arrow">→</span> <b class="win">ตอง K ชนะ</b></div></li>
    <li>ถ้ามี Joker ทั้งสองฝ่าย (โหมด 2 Joker) ดูเลขของกลุ่มหลักก่อน ถ้ายังเท่ากันให้ดู<b>ไพ่จริงใบสูงสุด</b> (ดูข้อ 4 ด้านล่าง)</li>
    <li><b>โหมด 2 Joker:</b> ถือ Joker ได้ทีละใบเท่านั้น ถ้าจะได้ใบที่สองตอนแจกหรือเปลี่ยนไพ่
      Joker ใบนั้นจะถูกใส่คืนกองแบบสุ่ม และคุณได้ใบถัดไปแทน (ถ้าไม่เหลือใบอื่น การจั่วนั้นถูกข้าม
      คุณเก็บใบเดิมไว้) · ถ้าทิ้ง Joker ไปแล้ว ภายหลังได้อีกใบได้</li>
  </ul>
</section>

<section>
  <h3>การตัดสินเมื่อมือเท่ากัน (ไม่มีเสมอ)</h3>
  <ol>
    <li>ดูประเภทมือก่อน</li>
    <li>ดูเลขของกลุ่มหลัก: คู่ A ชนะคู่ K · สองคู่ดูคู่สูงก่อนแล้วคู่ต่ำ · ฟูลเฮาส์ดูที่ตอง · ไพ่ประกอบไม่นับ</li>
    <li>ยังเท่ากันอีก ดู<b>ดอกของไพ่ใบสูงสุดในกลุ่มหลัก</b>: ♠ &gt; ♥ &gt; ♦ &gt; ♣
      <div class="th-example">${xsCards(E.suit.spade)} <span class="vs">vs</span> ${xsCards(E.suit.heart)}
        <span class="arrow">→</span> <b class="win">ฝ่ายที่มี A♠ ชนะ</b></div></li>
    <li>(เฉพาะ 2 Joker) ถ้ามี Joker ทั้งสองฝ่าย ไม่ต้องดูข้อ 3 — ตัด Joker ออกแล้วดู<b>ไพ่จริงใบสูงสุด</b>:
      ดูเลขก่อน แล้วดูดอก (♠ &gt; ♥ &gt; ♦ &gt; ♣) ถ้ายังเท่ากันดูไพ่จริงใบถัดไป
      <div class="th-example">${xsCards(E.bothJoker.lose)} <span class="muted">ไพ่จริงสูงสุด K♥</span>
        <span class="vs">vs</span> ${xsCards(E.bothJoker.win)} <span class="muted">ไพ่จริงสูงสุด A♣</span>
        <span class="arrow">→</span> <b class="win">ฝ่ายที่มี A♣ ชนะ</b></div></li>
  </ol>
</section>

<section>
  <h3>ตั้งค่า</h3>
  <dl>
    <dt>Joker 1 / 2 ใบ</dt><dd>1 ใบ = ไพ่ 21 ใบ · 2 ใบ = ไพ่ 22 ใบ (ถือ Joker ได้ทีละใบ)</dd>
    <dt>ไพ่ทิ้ง: เปิด</dt><dd>เห็นไพ่ที่ทิ้งของทั้งสองฝ่าย — AI ก็เห็นไพ่ทิ้งของคุณเหมือนกัน</dd>
    <dt>ไพ่ทิ้ง: คว่ำ</dt><dd>เห็นแค่จำนวนใบที่ทิ้ง ทั้งคุณและ AI</dd>
    <dt>ความยาก</dt><dd>Normal / Hard / Cheater (Cheater มองเห็นไพ่ในมือคุณ แต่<b>ไม่เห็นกองไพ่</b> — ไพ่ที่จะจั่วได้ยังเดาเหมือนระดับอื่น · มีป้ายเตือนบนโต๊ะ)</dd>
  </dl>
</section>

<section>
  <h3>ปุ่มลัด</h3>
  <p><kbd>←</kbd><kbd>→</kbd> เลื่อนระหว่างไพ่และปุ่ม · <kbd>↑</kbd><kbd>↓</kbd> เลือก/ยกเลิกไพ่ที่จะเปลี่ยน หรือปรับ Your bet ·
  <kbd>1</kbd>–<kbd>5</kbd> เลือกไพ่ · <kbd>B</kbd> BET · <kbd>R</kbd> RAISE · <kbd>C</kbd> CALL / ACCEPT · <kbd>D</kbd> DROP ·
  <kbd>Enter</kbd> กด · <kbd>Esc</kbd> ยกเลิก/ปิด · <kbd>M</kbd> ปิดเสียง</p>
</section>`;
}

/** Thai version of the "This table: …" line. */
export function modeLineTh(jokers: 1 | 2, faceUp: boolean): string {
  return `<p class="mode-line">โต๊ะนี้: <b>Joker ${jokers} ใบ</b> (ไพ่ ${jokers === 2 ? 22 : 21} ใบ) ·
    ไพ่ทิ้ง<b>${faceUp ? 'เปิด' : 'คว่ำ'}</b> — ${faceUp ? 'ทั้งสองฝ่ายเห็นไพ่ที่ทิ้งทุกใบ' : 'เห็นแค่จำนวนใบที่ทิ้ง'}</p>`;
}
