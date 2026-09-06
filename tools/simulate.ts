/**
 * 自動対戦ハーネス（表示側）。実行と集計は `tools/stats.ts`。
 *
 *   npm run simulate                          # 既定 200 戦（ランダムAI同士）
 *   npm run simulate -- --ai greedy           # 目的志向AI同士
 *   npm run simulate -- --compare             # ランダム / 目的志向 / 直接対決 の比較表
 *   npm run simulate -- --games 1000 --seed 7
 *   npm run simulate -- --gods earth,sky
 *   npm run simulate -- --save tmp/records    # 落ちた試合の記録を保存（--save-all で全試合）
 *
 * 出したい数字:
 *   - 神ごとの勝率（対戦相手の神別マトリクス）
 *   - 平均決着サイクル（設計目標は3、長くて4）
 *   - 特殊勝利ごとの達成率と、**達成できなかった条件がどこまで行ったか**
 *   - 先攻・後攻の勝率差
 *
 * ## シードの決め方
 *
 * 1試合のシードは (基準シード, 神の組み合わせ, 何戦目) から決まる。
 * `--games` を変えても同じ組み合わせの同じ番号なら同じ試合になるので、
 * 表示された seed をそのまま `npm run replay -- --p1 … --p2 … --seed …` に渡せば再現できる。
 */
import { mkdirSync, writeFileSync } from 'node:fs';

import { DECKS_DIR, PLAYABLE_GODS, loadDeckFile } from '../src/rules/decks.load';
import { runMatches, summarize, type AiKind, type Outcome, type Summary } from './stats';
import type { God } from '../src/rules/types';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

function optional(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function pct(x: number): string {
  return `${(100 * x).toFixed(1).padStart(5)}%`;
}

function printSummary(s: Summary, gods: God[]): void {
  console.log(`\n=== ${s.label}: ${s.games} 戦 ===`);
  console.log(`決着 ${s.decided} / エラー ${s.errors.length}`);

  console.log(`\n■ 平均決着サイクル: ${s.avgCycles.toFixed(2)}（設計目標3、長くて4）`);
  for (const c of s.cycleDist) {
    console.log(`   ${c.cycle}サイクル: ${String(c.n).padStart(4)} ${pct(c.n / s.decided)}`);
  }

  console.log(`\n■ 先攻・後攻`);
  console.log(`   決着時に先攻だった側の勝率 ${pct(s.firstWinRate)}（※神の強さと交絡している）`);
  console.log(`   対戦カードごとに、左の神が 先攻だったとき / 後攻だったとき の勝率`);
  for (const f of s.firstAdvantage) {
    const d = f.delta === undefined ? ' 試合数不足' : `${f.delta >= 0 ? '+' : ''}${(100 * f.delta).toFixed(1)}pt`;
    console.log(
      `     ${`${f.pair[0]} vs ${f.pair[1]}`.padEnd(16)} 先攻 ${pct(f.asFirst.rate)}(${String(f.asFirst.games).padStart(3)}戦)` +
        `  後攻 ${pct(f.asSecond.rate)}(${String(f.asSecond.games).padStart(3)}戦)  差 ${d}`,
    );
  }
  if (s.firstAdvantageMean !== undefined) {
    console.log(
      `   → 神と相性を除いた先攻の有利さ: ${s.firstAdvantageMean >= 0 ? '+' : ''}${(100 * s.firstAdvantageMean).toFixed(1)}pt`,
    );
  }

  console.log(`\n■ 神別勝率（行＝P1の神、列＝P2の神。値はP1の勝率）`);
  console.log(`          ${gods.map((g) => g.padStart(8)).join('')}`);
  for (const a of gods) {
    const row = gods.map((b) => {
      const m = s.matrix.find((x) => x.p1 === a && x.p2 === b);
      return (m ? pct(m.rate) : '  -  ').padStart(8);
    });
    console.log(`   ${a.padEnd(7)}${row.join('')}`);
  }
  console.log(`\n■ 神ごとの総合勝率`);
  for (const g of s.byGod) console.log(`   ${g.god.padEnd(9)} ${pct(g.rate)}  (${g.games}戦)`);

  console.log(`\n■ 勝因の内訳`);
  for (const r of s.reasons) console.log(`   ${pct(r.rate)} ${String(r.n).padStart(4)}  ${r.reason}`);

  console.log(`\n■ 勝利条件（達成率 / 到達した達成度の平均・最大）`);
  for (const o of s.objectives) {
    const mean = o.meanProgress === undefined ? '  -  ' : pct(o.meanProgress);
    const max = o.maxProgress === undefined ? '  -  ' : pct(o.maxProgress);
    console.log(`   ${pct(o.rate)} ${o.name.padEnd(12)} 平均 ${mean} / 最大 ${max}  (${o.god})`);
  }

  if (s.errors.length > 0) {
    console.log(`\n■ エラー内訳`);
    const by = new Map<string, typeof s.errors>();
    for (const e of s.errors) by.set(e.message, [...(by.get(e.message) ?? []), e]);
    for (const [msg, list] of [...by.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const first = list[0]!;
      console.log(`   [${String(list.length).padStart(4)}] ${msg}`);
      console.log(`          再現: npm run replay -- --p1 ${first.p1God} --p2 ${first.p2God} --seed ${first.seed}`);
    }
  }
}

/** ランダム / 目的志向 / 直接対決 の比較表 */
function printComparison(random: Summary, greedy: Summary, head: Outcome[], gods: God[]): void {
  const col = (a: string, b: string, c: string): string => `${a.padEnd(26)}${b.padStart(12)}${c.padStart(12)}`;
  console.log(`\n=== AI比較（各 ${random.games} 戦）===\n`);
  console.log(col('', 'ランダム', '目的志向'));
  console.log('─'.repeat(50));
  console.log(col('平均決着サイクル', random.avgCycles.toFixed(2), greedy.avgCycles.toFixed(2)));
  console.log(col('先攻の勝率（交絡あり）', pct(random.firstWinRate), pct(greedy.firstWinRate)));
  const adv = (x: Summary): string =>
    x.firstAdvantageMean === undefined
      ? '  -  '
      : `${x.firstAdvantageMean >= 0 ? '+' : ''}${(100 * x.firstAdvantageMean).toFixed(1)}pt`;
  console.log(col('先攻の有利さ（補正後）', adv(random), adv(greedy)));
  console.log(col('特殊勝利で決着', pct(random.objectiveWinRate), pct(greedy.objectiveWinRate)));
  console.log(col('エラー', String(random.errors.length), String(greedy.errors.length)));

  console.log(`\n■ 神ごとの総合勝率`);
  console.log(col('', 'ランダム', '目的志向'));
  for (const g of gods) {
    const r = random.byGod.find((x) => x.god === g);
    const y = greedy.byGod.find((x) => x.god === g);
    console.log(col(`  ${g}`, pct(r?.rate ?? 0), pct(y?.rate ?? 0)));
  }

  console.log(`\n■ 勝利条件ごとの達成率（括弧内は到達した達成度の平均）`);
  console.log(col('', 'ランダム', '目的志向'));
  for (const o of random.objectives) {
    const g = greedy.objectives.find((x) => x.id === o.id);
    const a = `${pct(o.rate)}${o.meanProgress === undefined ? '' : ` (${(100 * o.meanProgress).toFixed(0)}%)`}`;
    const b = `${pct(g?.rate ?? 0)}${g?.meanProgress === undefined ? '' : ` (${(100 * g.meanProgress).toFixed(0)}%)`}`;
    console.log(col(`  ${o.name}`, a, b));
  }

  const decided = head.filter((o) => o.winner === 'P1' || o.winner === 'P2');
  const greedyWins = decided.filter((o) => (o.ai.P1 === 'greedy' ? o.winner === 'P1' : o.winner === 'P2')).length;
  console.log(`\n■ 直接対決（目的志向 vs ランダム、同じ神・同じシードで先後を入れ替えた ${head.length} 戦）`);
  console.log(`   目的志向AIの勝率 ${pct(decided.length === 0 ? 0 : greedyWins / decided.length)}`);
  console.log(`   ※ 50%を明確に超えていれば「AIとして機能している」ことの確認になる`);
}

/**
 * `--deck <path>` を繰り返して、神ごとにデッキファイルを名指しする。
 * どの神のデッキかは**ファイルの `god:` 行から判る**ので、順番も名前も自由。
 * 同じ神を2つ渡したら黙って片方を捨てずにエラーにする。
 */
export function deckFilesFromArgs(argv: string[] = process.argv): Partial<Record<God, string>> {
  const out: Partial<Record<God, string>> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--deck') continue;
    const path = argv[i + 1];
    if (path === undefined) throw new Error('--deck のあとにデッキファイルのパスが要る');
    const deck = loadDeckFile(path);
    if (out[deck.god] !== undefined) {
      throw new Error(`${deck.god} のデッキが2つ指定されている: ${out[deck.god]} と ${path}`);
    }
    out[deck.god] = path;
  }
  return out;
}

async function main(): Promise<void> {
  const games = Number(arg('games', '200'));
  const seed = Number(arg('seed', '1'));
  const gods = arg('gods', PLAYABLE_GODS.join(',')).split(',') as God[];
  const saveDir = optional('save');
  const saveAll = process.argv.includes('--save-all');
  const compare = process.argv.includes('--compare');
  const ai = arg('ai', 'random') as AiKind;
  const decksDir = arg('decks', DECKS_DIR);
  const deckFiles = deckFilesFromArgs();

  if (saveDir) mkdirSync(saveDir, { recursive: true });
  const onRecord = saveDir
    ? (o: Outcome, rec: unknown): void => {
        if (!saveAll && !o.error) return;
        writeFileSync(`${saveDir}/${o.p1God}-${o.p2God}-${o.index}-${o.seed}.json`, JSON.stringify(rec, null, 2), 'utf-8');
      }
    : undefined;

  if (!compare) {
    const outcomes = await runMatches({
      games,
      seed,
      gods,
      decksDir,
      deckFiles,
      ai: { P1: ai, P2: ai },
      ...(onRecord ? { onRecord } : {}),
    });
    printSummary(summarize(ai === 'greedy' ? '目的志向AI' : 'ランダムAI', outcomes, gods), gods);
    console.log();
    return;
  }

  // 比較モード: 同じシードで3通り回す
  const randomOut = await runMatches({ games, seed, gods, decksDir, deckFiles, ai: { P1: 'random', P2: 'random' } });
  const greedyOut = await runMatches({ games, seed, gods, decksDir, deckFiles, ai: { P1: 'greedy', P2: 'greedy' } });
  // 直接対決は先後を入れ替えた2本立て（先攻の有利不利を打ち消す）
  const headA = await runMatches({ games: Math.round(games / 2), seed, gods, decksDir, deckFiles, ai: { P1: 'greedy', P2: 'random' } });
  const headB = await runMatches({ games: Math.round(games / 2), seed, gods, decksDir, deckFiles, ai: { P1: 'random', P2: 'greedy' } });

  const r = summarize('ランダムAI', randomOut, gods);
  const g = summarize('目的志向AI', greedyOut, gods);
  printSummary(r, gods);
  printSummary(g, gods);
  printComparison(r, g, [...headA, ...headB], gods);
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
