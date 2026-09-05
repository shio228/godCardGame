/**
 * `decks/*.txt` を TypeScript の文字列として書き出す（`src/rules/decks.generated.ts`）。
 *
 * サーバ（Vercel Functions）は実行時にファイルを読めるとは限らないので、
 * プリセットのデッキは**ビルド時に埋め込む**。`.txt` が正で、生成物との一致は
 * `src/rules/decks.generated.test.ts` が見張る。
 *
 *   npm run gen:decks
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DECKS_DIR } from '../src/rules/decks.load';

const OUT = 'src/rules/decks.generated.ts';

export function deckTexts(dir: string = DECKS_DIR): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir).sort()) {
    if (f.endsWith('.txt')) out[f.replace(/\.txt$/, '')] = readFileSync(join(dir, f), 'utf-8');
  }
  return out;
}

export function render(texts: Record<string, string>): string {
  const entries = Object.entries(texts)
    .map(([name, text]) => `  ${JSON.stringify(name)}: ${JSON.stringify(text)},`)
    .join('\n');
  return `/**
 * decks/*.txt の中身。**${'@'}generated — 手で編集しない。**
 * デッキを直すときは decks/*.txt を編集して \`npm run gen:decks\` を実行する。
 *
 * サーバ（Vercel Functions）は実行時にリポジトリのファイルを読めるとは限らないので、
 * プリセットはここに埋め込んでおく。
 */

export const DECK_TEXTS: Record<string, string> = {
${entries}
};

export const PRESET_NAMES: string[] = Object.keys(DECK_TEXTS);
`;
}

if (process.argv[1]?.endsWith('gen-decks.ts') === true) {
  const texts = deckTexts();
  writeFileSync(OUT, render(texts), 'utf-8');
  console.log(`${OUT} を書き出した（${Object.keys(texts).length}本）`);
}
