/**
 * デッキビルダーのHTMLを作る。
 *
 *   npm run builder                        # tmp/deckbuilder.html
 *   npm run builder -- --out docs/deck.html
 *   npm run builder -- --fragment          # Artifact 公開用（<html> の枠なし）
 *
 * やっていることは3つ:
 *   ① カードと勝利条件から**表示に要る項目だけ**の索引を作る（効果ツリーは載せない）
 *   ② `src/browser/deckbuilder.entry.ts` を esbuild で1つに束ねる
 *      （デッキリストのパーサ本体。画面はこれを呼ぶので、CLIと判定がずれない）
 *   ③ 索引・束ねたJS・UI を1枚のHTMLにする
 */
import { buildSync } from 'esbuild';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { samplePool } from '../src/rules/cards.sample';
import { DECKS_DIR } from '../src/rules/decks.load';
import { DECK_MAX, DECK_MIN, MAX_COPIES, OBJECTIVE_MIN } from '../src/rules/limits';
import type { BuilderData, CardIndexEntry, ObjectiveIndexEntry } from '../src/browser/deckbuilder.entry';
import { renderDeckBuilder } from './deckbuilder.template';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

/** 表示に要る項目だけを抜く。効果（`abilities`）は載せない */
export function cardIndex(): CardIndexEntry[] {
  return samplePool.cards.map((c) => ({
    id: c.id,
    name: c.name,
    god: c.god,
    types: c.types,
    text: c.text,
    keywords: c.keywords ?? [],
    restricted: c.play !== undefined,
  }));
}

export function objectiveIndex(): ObjectiveIndexEntry[] {
  return samplePool.objectives.map((o) => ({
    id: o.id,
    name: o.name,
    god: o.god,
    initiative: o.initiative,
    text: o.text,
  }));
}

/** `decks/*.txt` を読み込み用に同梱する */
function sampleDecks(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.txt')) out[f.replace(/\.txt$/, '')] = readFileSync(join(dir, f), 'utf-8');
  }
  return out;
}

export function builderData(decksDir = DECKS_DIR): BuilderData {
  const used = new Set(samplePool.objectives.map((o) => o.god));
  return {
    cards: cardIndex(),
    objectives: objectiveIndex(),
    // 勝利条件がデータ化されている神だけ（創造は組めない）
    gods: samplePool.gods.filter((g) => used.has(g.id)).map((g) => ({ id: g.id, name: g.name })),
    decks: sampleDecks(decksDir),
    limits: { deckMin: DECK_MIN, deckMax: DECK_MAX, maxCopies: MAX_COPIES, objectiveMin: OBJECTIVE_MIN },
  };
}

/** パーサをブラウザ用に束ねる。`window.Deck` として使えるようにする */
export function bundleParser(): string {
  const built = buildSync({
    entryPoints: ['src/browser/deckbuilder.entry.ts'],
    bundle: true,
    format: 'iife',
    globalName: 'Deck',
    target: 'es2022',
    minify: true,
    write: false,
    logLevel: 'warning',
  });
  const file = built.outputFiles[0];
  if (!file) throw new Error('バンドルが生成されなかった');
  return file.text;
}

function main(): void {
  const out = arg('out', 'tmp/deckbuilder.html');
  const decksDir = arg('decks', DECKS_DIR);
  const fragment = process.argv.includes('--fragment');

  const data = builderData(decksDir);
  const bundle = bundleParser();
  const html = renderDeckBuilder(data, bundle, { standalone: !fragment });

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html, 'utf-8');
  console.log(
    `${out} を書き出した（カード${data.cards.length}枚 / 勝利条件${data.objectives.length}件 / ` +
      `同梱デッキ${Object.keys(data.decks).length}本 / パーサ${(bundle.length / 1024).toFixed(1)}KB）`,
  );
}

// 直接実行したときだけ走らせる（テストが builderData を import しても書き出さない）
if (process.argv[1]?.endsWith('deckbuilder.ts') === true) main();
