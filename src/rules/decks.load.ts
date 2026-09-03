/**
 * デッキファイル（`decks/*.txt`）の読み込み。
 *
 * **`node:fs` を使うのはこのモジュールだけ。** エンジン（`src/engine/`）と
 * カードデータ（`src/rules/*.sample.ts`）はファイルに触らないので、
 * 将来ブラウザに載せるときはここを import しなければよい。
 *
 * 書式そのものは `src/engine/decklist.ts`（純粋なパーサ）が持つ。
 */
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { parseDeckList, type ParsedDeck } from '../engine/decklist';
import { PoolIndex } from '../engine/pool';
import { samplePool } from './cards.sample';
import type { God } from './types';

/** デッキファイルの置き場（リポジトリのルートからの相対） */
export const DECKS_DIR = 'decks';

/** デッキを用意してある神。創造は勝利条件が未データ化なので入らない */
export const PLAYABLE_GODS: God[] = ['earth', 'sea', 'sky', 'life'];

const index = new PoolIndex(samplePool);
const cache = new Map<string, ParsedDeck>();

/** パスを指定して読む。同じパスは読み直さない */
export function loadDeckFile(path: string): ParsedDeck {
  const hit = cache.get(path);
  if (hit) return hit;
  const text = readFileSync(path, 'utf-8');
  const deck = parseDeckList(text, index, { name: basename(path).replace(/\.txt$/, '') });
  cache.set(path, deck);
  return deck;
}

/** その神の既定デッキ（`decks/<god>.txt`）を読む */
export function loadDeck(god: God, dir: string = DECKS_DIR): ParsedDeck {
  return loadDeckFile(join(dir, `${god}.txt`));
}
