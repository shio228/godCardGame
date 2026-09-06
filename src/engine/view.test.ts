/**
 * 視点別ビュー。**遠隔対戦で相手に渡してよいものだけが入っている**ことを担保する。
 * ここが漏れると対戦が成立しないので、JSON文字列レベルで確かめる。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { samplePool } from '../rules/cards.sample';
import { loadDeck } from '../rules/decks.load';
import { AutoChooser } from './chooser';
import { createEngine, drawPhase, play, putInHand, startCycle, startGame, surrender } from './flow';
import { playerView } from './view';
import type { Engine } from './context';

async function started(): Promise<Engine> {
  const engine = createEngine({
    pool: samplePool,
    p1God: 'earth',
    p2God: 'sky',
    seed: 4242,
    budget: 30000,
    chooser: new AutoChooser(),
  });
  await startGame(engine, { P1: loadDeck('earth'), P2: loadDeck('sky') });
  // 初期手札7枚は「0サイクル目のドロー」なので、そこまで進めてから見る
  await startCycle(engine);
  await drawPhase(engine);
  return engine;
}

describe('ビューに入るもの', () => {
  it('自分の手札は中身つき、相手は枚数だけ', async () => {
    const engine = await started();
    const v = await playerView(engine, 'P1');

    assert.equal(v.you, 'P1');
    assert.equal(v.me.hand?.length, 7);
    assert.ok(v.me.hand?.every((c) => c.name && c.text), '名前と印刷テキストが入る');
    assert.equal(v.opp.hand, undefined, '相手の手札は入らない');
    assert.equal(v.opp.handCount, 7, '枚数は見える');
  });

  it('自分の伏せた勝利条件は見えるが、相手のは件数だけ', async () => {
    const engine = await started();
    const v = await playerView(engine, 'P1');

    // 0サイクル目の開始フェイズで1つ公開されるので、伏せは残り2つ
    assert.equal(v.me.hidden?.length, 2);
    assert.ok(v.me.hidden?.every((o) => o.name && o.text));
    assert.equal(v.opp.hidden, undefined, '相手の伏せ札は中身が入らない');
    assert.equal(v.opp.hiddenCount, 2, '件数だけ見える');
  });

  it('公開された勝利条件は両者に見え、達成度も付く', async () => {
    const engine = await started(); // 0サイクル目の開始で1つずつ公開されている
    const v = await playerView(engine, 'P1');

    assert.equal(v.me.revealed.length, 1);
    assert.equal(v.opp.revealed.length, 1);
    assert.ok(v.me.revealed[0]!.detail, '「6 >= 10」のような内訳が付く');
  });

  it('スタックは両者に見える', async () => {
    const engine = await started();
    engine.state.phase = 'stack';
    const [c] = putInHand(engine, 'P1', ['earth/crimson_ignition']);
    await play(engine, 'P1', c!);

    const v = await playerView(engine, 'P2');
    const names = v.stacks.flatMap((s) => s.items.map((i) => i.name));
    assert.ok(names.includes('紅蓮着火'), '相手のスタックの項目名は見える');
  });

  it('勝敗が決まったら結果が入る', async () => {
    const engine = await started();
    surrender(engine, 'P1');
    const v = await playerView(engine, 'P1');
    assert.deepEqual(v.result?.winner, 'P2');
    assert.equal(v.result?.reason, '降伏');
  });

  it('ログは途中から切り出せる（演出のタイムライン用）', async () => {
    const engine = await started();
    const all = await playerView(engine, 'P1');
    assert.ok(all.log.length > 0);
    assert.equal(all.logLength, engine.log.length);

    const tail = await playerView(engine, 'P1', { logFrom: engine.log.length - 2 });
    assert.equal(tail.log.length, 2);
    assert.equal(tail.logLength, engine.log.length);
  });

  it('表示名を差せる', async () => {
    const engine = await started();
    const v = await playerView(engine, 'P1', { names: { P1: 'あなた', P2: '相手' } });
    assert.equal(v.me.name, 'あなた');
    assert.equal(v.opp.name, '相手');
  });
});

describe('ビューに入ってはいけないもの', () => {
  it('相手の手札のカード名が1つも出ない', async () => {
    const engine = await started();
    const json = JSON.stringify(await playerView(engine, 'P1'));

    const oppHand = engine.state.players.P2.zones.hand[0]!;
    for (const c of oppHand) {
      const name = samplePool.cards.find((x) => x.id === c.defId)!.name;
      assert.equal(json.includes(name), false, `相手の手札 "${name}" が漏れている`);
    }
  });

  it('相手の伏せた勝利条件の名前が出ない', async () => {
    const engine = await started();
    const json = JSON.stringify(await playerView(engine, 'P1'));

    for (const id of engine.state.players.P2.objectives) {
      const o = samplePool.objectives.find((x) => x.id === id)!;
      assert.equal(json.includes(o.name), false, `相手の伏せ札 "${o.name}" が漏れている`);
      assert.equal(json.includes(o.id), false, `相手の伏せ札のID "${o.id}" が漏れている`);
    }
  });

  it('乱数の内部状態・limitUses・events・山札の中身が出ない', async () => {
    const engine = await started();
    await startCycle(engine);
    const json = JSON.stringify(await playerView(engine, 'P1'));

    // rng を渡すと以後のシャッフルが予測できてしまう
    assert.equal(json.includes(String(engine.state.rng)), false, 'rng が漏れている');
    assert.equal(json.includes('"rng"'), false);
    // limitUses のキーは `objective:<player>:<id>` 形式で伏せ札のIDを含む
    assert.equal(json.includes('limitUses'), false);
    assert.equal(json.includes('objective:'), false);
    // events[].bindings には引いたカードの実体が入る
    assert.equal(json.includes('"events"'), false);
    assert.equal(json.includes('"bindings"'), false);
    assert.equal(json.includes('"snapshots"'), false);

    // 自分の山札の中身も送らない（見えないものは持たせない）
    const myDeck = engine.state.players.P1.zones.deck[0]!;
    const inDeckOnly = myDeck.filter(
      (c) => !engine.state.players.P1.zones.hand[0]!.some((h) => h.defId === c.defId),
    );
    if (inDeckOnly.length > 0) {
      assert.equal(json.includes(inDeckOnly[0]!.uid), false, '山札のカードが漏れている');
    }
  });

  it('相手視点でも同じことが成り立つ（対称）', async () => {
    const engine = await started();
    const json = JSON.stringify(await playerView(engine, 'P2'));
    for (const c of engine.state.players.P1.zones.hand[0]!) {
      const name = samplePool.cards.find((x) => x.id === c.defId)!.name;
      assert.equal(json.includes(name), false, `P1の手札 "${name}" が漏れている`);
    }
  });
});
