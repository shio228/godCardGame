/**
 * デッキリスト（人が手で書くテキスト）の読み書き。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { samplePool } from '../rules/cards.sample';
import { DeckListError, formatDeckList, parseDeckList } from './decklist';
import { PoolIndex } from './pool';

const pool = new PoolIndex(samplePool);

/** 30枚に足りるだけの最小の本文（大地） */
const EARTH_BODY = `
3 紅蓮着火
3 鎧袖一触
3 コンビネーション
3 ランページチェイン
3 天焦灼火
3 インスタントフォージ
3 鍛刃天晴
3 煮え滾る地脈
3 ブレイジングラッシュ
3 フレイムフォース
`;

function parse(text: string) {
  return parseDeckList(text, pool, { name: 'test' });
}

describe('デッキリストの読み込み', () => {
  it('枚数ぶんカードIDに展開する', () => {
    const deck = parse(`god: earth\n${EARTH_BODY}`);
    assert.equal(deck.cards.length, 30);
    assert.equal(deck.cards.filter((id) => id === 'earth/crimson_ignition').length, 3);
    assert.equal(deck.god, 'earth');
  });

  it('コメント・空行・行末コメントを飛ばす', () => {
    const deck = parse(`
# これはコメント
god: earth

3 紅蓮着火   # 主力
${EARTH_BODY.replace('3 紅蓮着火', '')}
`);
    assert.equal(deck.cards.length, 30);
  });

  it('枚数を省略したら1枚', () => {
    const deck = parse(`god: earth\n${EARTH_BODY.replace('3 フレイムフォース', 'フレイムフォース')}\n2 破壊宣告`);
    assert.equal(deck.cards.filter((id) => id === 'earth/flame_force').length, 1);
    assert.equal(deck.cards.length, 30);
  });

  it('name と objectives を読む', () => {
    const deck = parse(`name: 試作\ngod: earth\nobjectives: 十連撃の誓約, 一撃必殺, 完全武装の証明\n${EARTH_BODY}`);
    assert.equal(deck.name, '試作');
    assert.deepEqual(deck.objectives, [
      'earth/obj_ten_strikes',
      'earth/obj_single_blow',
      'earth/obj_full_arsenal',
    ]);
  });

  it('objectives を省略したらその神の勝利条件を全部採用する', () => {
    const deck = parse(`god: earth\n${EARTH_BODY}`);
    assert.equal(deck.objectives.length, 3);
    assert.ok(deck.objectives.every((id) => pool.objective(id).god === 'earth'));
  });
});

describe('デッキリストの記述ミス', () => {
  const bad = (text: string): string => {
    try {
      parse(text);
    } catch (e) {
      return (e as Error).message;
    }
    return '（エラーにならなかった）';
  };

  it('知らないカード名は行番号と候補つきで落ちる', () => {
    const msg = bad(`god: earth\n3 紅蓮着人\n${EARTH_BODY}`);
    assert.match(msg, /2行目/);
    assert.match(msg, /紅蓮着人/);
    assert.match(msg, /候補: .*紅蓮着火/);
  });

  it('知らない勝利条件名も候補つきで落ちる', () => {
    const msg = bad(`god: earth\nobjectives: 十連撃の誓い\n${EARTH_BODY}`);
    assert.match(msg, /2行目/);
    assert.match(msg, /候補: .*十連撃の誓約/);
  });

  it('他の神のカードは弾く', () => {
    const msg = bad(`god: earth\n3 未来の選択\n${EARTH_BODY}`);
    assert.match(msg, /sea のカード/);
  });

  it('他の神の勝利条件は弾く', () => {
    const msg = bad(`god: earth\nobjectives: 詠唱の極致\n${EARTH_BODY}`);
    assert.match(msg, /sea の勝利条件/);
  });

  it('同名4枚は弾く', () => {
    const msg = bad(`god: earth\n4 紅蓮着火\n${EARTH_BODY.replace('3 紅蓮着火', '')}\n2 破壊宣告`);
    assert.match(msg, /3枚まで/);
  });

  it('枚数が足りなければ弾く', () => {
    assert.match(bad('god: earth\n3 紅蓮着火'), /30〜40枚/);
  });

  it('god が無ければ弾く', () => {
    assert.match(bad(EARTH_BODY), /god:/);
  });

  it('知らない項目は弾く', () => {
    assert.match(bad(`god: earth\ncolor: red\n${EARTH_BODY}`), /"color:" という項目は無い/);
  });

  it('DeckListError で投げる', () => {
    assert.throws(() => parse('god: earth\n3 紅蓮着人'), DeckListError);
  });
});

describe('デッキリストの書き出し', () => {
  it('書き出したものを読み戻すと同じデッキになる', () => {
    const deck = parse(`name: 往復\ngod: earth\n${EARTH_BODY}`);
    const text = formatDeckList(deck, pool, { comments: ['往復のテスト'] });
    const again = parseDeckList(text, pool);

    assert.equal(again.name, deck.name);
    assert.equal(again.god, deck.god);
    assert.deepEqual([...again.cards].sort(), [...deck.cards].sort());
    assert.deepEqual(again.objectives, deck.objectives);
    assert.match(text, /^# 往復のテスト/);
  });
});
