/**
 * 埋め込んだデッキが `decks/*.txt` と一致していること。
 *
 * 正は `.txt` のほう。ずれたまま気付かないと、
 * **手元のCLIとサーバで違うデッキで遊ぶ**ことになる。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { deckTexts, render } from '../../tools/gen-decks';
import { PoolIndex } from '../engine/pool';
import { parseDeckList } from '../engine/decklist';
import { samplePool } from './cards.sample';
import { DECK_TEXTS, PRESET_NAMES } from './decks.generated';

const OUT = 'src/rules/decks.generated.ts';

describe('埋め込みデッキ', () => {
  it('decks/*.txt と一致している（ずれたら npm run gen:decks）', () => {
    const expected = render(deckTexts());
    const actual = readFileSync(OUT, 'utf-8').replace(/\r\n/g, '\n');
    assert.equal(actual, expected, `${OUT} が decks/*.txt と食い違っている。npm run gen:decks を実行する`);
  });

  it('どの神にも1本以上ある（同神対決を避けられる）', () => {
    const index = new PoolIndex(samplePool);
    const gods = PRESET_NAMES.map((n) => parseDeckList(DECK_TEXTS[n]!, index, { name: n }).god);

    for (const g of ['earth', 'life', 'sea', 'sky']) {
      assert.ok(gods.includes(g as never), `${g} のデッキが1本も無い`);
    }
    // AI の席は「相手と違う神」を選ぶので、2種類以上あれば必ず組める
    assert.ok(new Set(gods).size >= 2, '神が1種類しかないと対戦を組めない');
  });
});
