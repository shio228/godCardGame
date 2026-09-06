/**
 * デッキビルダー。
 *
 * 肝は「**画面の合否とCLIの合否が一致すること**」なので、
 * ブラウザ側と同じ経路（埋め込み索引 → `makePool` → 本物のパーサ）で確かめる。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

import { samplePool } from '../src/rules/cards.sample';
import { check, load, makePool, toDeck } from '../src/browser/deckbuilder.entry';
import { PoolIndex } from '../src/engine/pool';
import { parseDeckList } from '../src/engine/decklist';
import { builderData, cardIndex, objectiveIndex } from './deckbuilder';
import { renderDeckBuilder } from './deckbuilder.template';

const data = builderData();
const pool = makePool(data);

describe('埋め込む索引', () => {
  it('カード92枚ぶんの表示情報が揃う', () => {
    const cards = cardIndex();
    assert.equal(cards.length, samplePool.cards.length);
    assert.ok(cards.every((c) => c.id && c.name && c.god && c.types.length > 0 && c.text));
    // 名前は一意（名前でデッキを書くための前提）
    assert.equal(new Set(cards.map((c) => c.name)).size, cards.length);
  });

  it('効果の中身は載せない（軽くするため）', () => {
    const json = JSON.stringify(cardIndex());
    assert.equal(json.includes('"abilities"'), false);
    assert.equal(json.includes('"onResolve"'), false);
  });

  it('勝利条件は先行度つきで載る', () => {
    const objs = objectiveIndex();
    assert.equal(objs.length, samplePool.objectives.length);
    assert.ok(objs.every((o) => o.initiative !== undefined && o.text));
  });

  it('デッキを組める神だけを出す（創造は勝利条件が無いので入らない）', () => {
    assert.deepEqual(
      data.gods.map((g) => g.id).sort(),
      ['earth', 'life', 'sea', 'sky'],
    );
  });

  it('decks/ のデッキを全部同梱し、どの神にも1本以上ある', () => {
    const names = Object.keys(data.decks);
    assert.ok(names.length >= 4, `同梱デッキが少なすぎる: ${names.join(', ')}`);
    const gods = new Set(Object.entries(data.decks).map(([name, text]) => load(text, pool).god));
    for (const g of ['earth', 'life', 'sea', 'sky']) assert.ok(gods.has(g as never), `${g} のデッキが無い`);
  });
});

describe('ブラウザ側の経路', () => {
  it('索引から組んだプールで本物のパーサが動く', () => {
    const text = data.decks.earth!;
    const deck = load(text, pool);
    assert.equal(deck.god, 'earth');
    assert.equal(deck.cards.length, 30);
  });

  it('索引のプールと本物のプールで、同じデッキが同じ結果になる', () => {
    const real = new PoolIndex(samplePool);
    for (const [name, text] of Object.entries(data.decks)) {
      const a = parseDeckList(text, real, { name });
      const b = parseDeckList(text, pool, { name });
      assert.deepEqual(b.cards, a.cards, name);
      assert.deepEqual(b.objectives, a.objectives, name);
    }
  });

  it('組んだデッキが合法なら、その場でテキストにして読み戻せる', () => {
    const counts: Record<string, number> = {};
    for (const id of load(data.decks.sea!, pool).cards) counts[id] = (counts[id] ?? 0) + 1;
    const deck = toDeck('試作', 'sea', counts, load(data.decks.sea!, pool).objectives);

    const res = check(deck, pool, ['ビルダーから']);
    assert.equal(res.ok, true, res.error ?? '');
    // 出したテキストは CLI と同じパーサを通る
    assert.doesNotThrow(() => parseDeckList(res.text, new PoolIndex(samplePool)));
  });

  it('枚数が足りなければ、CLIと同じ文面で落ちる', () => {
    const deck = toDeck('半端', 'earth', { 'earth/crimson_ignition': 3 }, [
      'earth/obj_ten_strikes',
      'earth/obj_full_arsenal',
      'earth/obj_single_blow',
    ]);
    const res = check(deck, pool, []);
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /30〜40枚/);
  });

  it('勝利条件が3つ未満なら落ちる', () => {
    const counts: Record<string, number> = {};
    for (const id of load(data.decks.earth!, pool).cards) counts[id] = (counts[id] ?? 0) + 1;
    const res = check(toDeck('条件不足', 'earth', counts, ['earth/obj_ten_strikes']), pool, []);
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /3つ以上/);
  });
});

describe('HTMLの生成', () => {
  const bundle = 'var Deck = {};';

  it('自己完結したページになる', () => {
    const html = renderDeckBuilder(data, bundle);
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<title>デッキ工房<\/title>/);
    assert.ok(html.includes('window.__BUILDER__'));
    assert.ok(html.includes(bundle));
  });

  it('Artifact 用は <html> の枠を出さない', () => {
    const html = renderDeckBuilder(data, bundle, { standalone: false });
    assert.equal(html.startsWith('<!doctype'), false);
    assert.match(html, /<title>デッキ工房<\/title>/);
  });

  it('埋め込むJSONが </script> でページを壊さない', () => {
    const html = renderDeckBuilder(data, bundle);
    const embedded = html.slice(html.indexOf('window.__BUILDER__'), html.indexOf('</script>'));
    assert.equal(embedded.includes('</'), false);
  });
});

describe('生成物', () => {
  it('esbuild で束ねたパーサが window.Deck を作る形になっている', () => {
    // 実際のバンドルは npm run builder が作る。ここでは出力済みのHTMLがあれば形を見る
    let html: string;
    try {
      html = readFileSync('tmp/deckbuilder.html', 'utf-8');
    } catch {
      return; // まだ生成していないときは飛ばす
    }
    assert.ok(html.includes('var Deck'), 'グローバル Deck が定義されていない');
    assert.ok(html.includes('makePool'));
  });
});
