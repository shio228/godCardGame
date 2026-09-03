/**
 * 記録と再生のCLI。
 *
 *   # 1試合を記録して実行し、行動ログを出す（記録は再生して一致を確認する）
 *   npm run replay -- --p1 earth --p2 sky --seed 42
 *   npm run replay -- --p1 earth --p2 sky --seed 42 --out tmp/game.json
 *
 *   # 保存した記録を再生する
 *   npm run replay -- --in tmp/game.json
 *
 *   # 出力の絞り込み
 *   --log actions   行動だけ（既定）
 *   --log all       効果の内部まで全部
 *   --log none      ログを出さない
 *   --choices       選択（誰が何を選んだか）も出す
 *
 * `simulate` が落ちた試合を出したときは、そこに表示される seed をそのまま
 * `--p1 <神> --p2 <神> --seed <値>` に渡せば同じ試合を再現できる。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { samplePool } from '../src/rules/cards.sample';
import { loadDeck } from '../src/rules/decks.load';
import {
  assertReplayMatches,
  formatChoices,
  formatLog,
  recordGame,
  replayGame,
  type GameRecord,
} from '../src/engine/replay';
import type { God } from '../src/rules/types';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function printLog(record: GameRecord): void {
  const mode = arg('log', 'actions');
  if (mode === 'none') return;
  const lines = formatLog(record.log, mode === 'actions' ? { kindsOnly: true } : {});
  console.log(lines.join('\n'));
}

function printResult(record: GameRecord): void {
  const r = record.result;
  console.log('');
  if (r.error) console.log(`結果: エラー — ${r.error}（サイクル ${r.cycles}）`);
  else console.log(`結果: ${r.winner} の勝ち（サイクル ${r.cycles} / 勝因 ${r.reason ?? '不明'}）`);
  console.log(`記録: 選択 ${record.choices.length} 手 / ログ ${record.log.length} 行`);
}

async function main(): Promise<void> {
  const inFile = arg('in');

  // ---- 保存済みの記録を再生する ----
  if (inFile) {
    const record = JSON.parse(readFileSync(inFile, 'utf-8')) as GameRecord;
    console.log(
      `再生: ${record.setup.p1God} vs ${record.setup.p2God}（seed ${record.setup.seed} / ${record.choices.length}手）\n`,
    );
    const replayed = await replayGame(samplePool, record);
    printLog({ ...record, log: replayed.engine.log });
    if (has('choices')) console.log('\n' + formatChoices(record.choices).join('\n'));
    printResult({ ...record, result: replayed.result });

    if (replayed.matched) {
      console.log(`\n記録と一致（${replayed.consumed}/${replayed.total}手を消費）`);
    } else {
      console.log(`\n記録と一致しない:\n  ${replayed.diff.join('\n  ')}`);
      process.exit(1);
    }
    return;
  }

  // ---- 新しく1試合を記録する ----
  const p1God = (arg('p1', 'earth') ?? 'earth') as God;
  const p2God = (arg('p2', 'sky') ?? 'sky') as God;
  const seed = Number(arg('seed', '1'));

  const { record } = await recordGame({
    pool: samplePool,
    p1God,
    p2God,
    decks: { P1: loadDeck(p1God), P2: loadDeck(p2God) },
    seed,
  });

  console.log(`記録: ${p1God} vs ${p2God}（seed ${seed}）\n`);
  printLog(record);
  if (has('choices')) console.log('\n' + formatChoices(record.choices).join('\n'));
  printResult(record);

  // 記録がそのまま再生できることを確認する（記録の取りこぼしはここで出る）
  const replayed = await replayGame(samplePool, record);
  assertReplayMatches(replayed);
  console.log('再生検証: 一致');

  const out = arg('out');
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(record, null, 2), 'utf-8');
    console.log(`保存: ${out}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
