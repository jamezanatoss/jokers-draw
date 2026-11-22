/**
 * Diagnose Hard's decisions: action mix, CALL sizes and hand strength at each CALL.
 *   npx vitest run --config scripts/vitest.bench.config.ts diagnose --silent=false
 * Env: HANDS (min hands, default 600), JOKERS (1|2), OPP (heuristic|normal).
 */
import { it } from 'vitest';
import { diagnose, report } from './diagLib';

it('diagnose Hard', () => {
  const hands = Number(process.env.HANDS ?? 600);
  const jokers = (Number(process.env.JOKERS ?? 1) as 1 | 2);
  const opp = (process.env.OPP ?? 'heuristic') as 'heuristic' | 'normal';
  console.log(`=== Hard vs ${opp}, ${jokers} Joker(s), ≥${hands} hands ===\n${report(diagnose({ hands, jokers, opp }))}`);
});
