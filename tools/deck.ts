/**
 * デッキリストの検証と要約。
 *
 *   npm run deck                      # decks/ の全ファイルを検証
 *   npm run deck -- decks/earth.txt   # 1つを詳しく見る
 *   npm run deck -- decks/earth.txt --text   # 各カードの印刷テキストも出す
 *
 * カード名が違う・枚数が足りない・他の神のカードが混ざっている、といった記述ミスは
 * ここで**行番号と候補つき**で落ちる。試合を回す前にこれを通す。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { samplePool } from '../src/rules/cards.sample';
import { DECKS_DIR } from '../src/rules/decks.load';
import { parseDeckList, type ParsedDeck } from '../src/engine/decklist';
import { PoolIndex } from '../src/engine/pool';

const pool = new PoolIndex(samplePool);
const showText = process.argv.includes('--text');

function summarize(path: string, deck: ParsedDeck): void {
  const counts = new Map<string, number>();
  for (const id of deck.cards) counts.set(id, (counts.get(id) ?? 0) + 1);

  const types = new Map<string, number>();
  for (const [id, n] of counts) {
    for (const t of pool.card(id).types) types.set(t, (types.get(t) ?? 0) + n);
  }

  console.log(`\n=== ${deck.name} （${path}）===`);
  console.log(`神 ${deck.god} / ${deck.cards.length} 枚 / ${counts.size} 種類`);

  console.log(`\n■ 勝利条件`);
  for (const id of deck.objectives) {
    const o = pool.objective(id);
    console.log(`   先行度${String(o.initiative).padStart(2)}  ${o.name}`);
    console.log(`             ${o.text.replace(/\n/g, ' ')}`);
  }

  console.log(`\n■ タイプ内訳`);
  const sorted = [...types.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`   ${sorted.map(([t, n]) => `${t} ${n}`).join(' / ')}`);

  console.log(`\n■ 内訳`);
  for (const [id, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    const c = pool.card(id);
    const kw = c.keywords?.length ? `〈${c.keywords.join(',')}〉` : '';
    console.log(`   ${n}  ${c.name}${kw}`);
    if (showText) console.log(`      ${c.text.replace(/\n/g, '\n      ')}`);
  }
}

function main(): void {
  const files = process.argv.slice(2).filter((a) => a.endsWith('.txt'));
  const targets =
    files.length > 0
      ? files
      : readdirSync(DECKS_DIR)
          .filter((f) => f.endsWith('.txt'))
          .map((f) => join(DECKS_DIR, f));

  let ng = 0;
  for (const path of targets) {
    try {
      const deck = parseDeckList(readFileSync(path, 'utf-8'), pool, {
        name: path.replace(/^.*[\\/]/, '').replace(/\.txt$/, ''),
      });
      if (targets.length === 1) summarize(path, deck);
      else console.log(`✔ ${path.padEnd(20)} ${deck.name} / ${deck.god} / ${deck.cards.length}枚`);
    } catch (err) {
      ng++;
      console.log(`✘ ${path}\n    ${(err as Error).message}`);
    }
  }
  if (ng > 0) {
    console.log(`\n${ng} 件のデッキに問題があります`);
    process.exit(1);
  }
}

main();
