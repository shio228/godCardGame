/**
 * 再生して次の選択で止める仕掛け。
 *
 * サーバは常駐しないので、対戦の実体は「選択の列」しかない。
 * **同じ列からは必ず同じ盤面に着く**ことと、
 * **出来上がった列が既存の `replayGame` を通る**ことが、この設計の土台になる。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RandomChooser } from '../engine/chooser';
import { parseDeckList } from '../engine/decklist';
import { PoolIndex } from '../engine/pool';
import { RECORD_VERSION, replayGame, type GameRecord, type GameSetup, type RecordedChoice } from '../engine/replay';
import { samplePool } from '../rules/cards.sample';
import { DECK_TEXTS } from '../rules/decks.generated';
import { askChooser, answerToChoice, resumeGame, ResumeError } from './resume';
import type { PendingRequest } from './protocol';

const index = new PoolIndex(samplePool);

function setupOf(seed = 4242): GameSetup {
  const p1 = parseDeckList(DECK_TEXTS.earth!, index, { name: 'earth' });
  const p2 = parseDeckList(DECK_TEXTS.sky!, index, { name: 'sky' });
  return {
    p1God: p1.god,
    p2God: p2.god,
    decks: {
      P1: { cards: p1.cards, objectives: p1.objectives },
      P2: { cards: p2.cards, objectives: p2.objectives },
    },
    seed,
  };
}

/** 決着まで打ち切って、選択の列と最後の再生結果を返す */
async function playOut(setup: GameSetup, seed = 9): Promise<{
  choices: RecordedChoice[];
  last: Awaited<ReturnType<typeof resumeGame>>;
}> {
  const choices: RecordedChoice[] = [];
  const chooser = new RandomChooser(seed);
  for (let step = 0; step < 2000; step++) {
    const res = await resumeGame(samplePool, setup, choices);
    assert.equal(res.error, undefined, `再生が落ちた: ${res.error}`);
    if (!res.raw) return { choices, last: res };
    choices.push(await askChooser(chooser, res.raw));
  }
  throw new Error('決着しない');
}

// ============================================================

describe('resumeGame', () => {
  it('選択が無ければ最初の選択のところで止まる', async () => {
    const res = await resumeGame(samplePool, setupOf(), []);

    assert.ok(res.pending, '入力待ちで止まる');
    assert.equal(res.pending!.index, 0, '0手目を求めている');
    assert.equal(res.result, undefined, 'まだ決着していない');
    assert.ok(res.views.P1 && res.views.P2, '両席のビューが揃う');
  });

  it('同じ列からは何度でも同じ盤面に着く', async () => {
    const setup = setupOf();
    const { choices } = await playOut(setup);
    const half = choices.slice(0, Math.floor(choices.length / 2));

    const a = await resumeGame(samplePool, setup, half);
    const b = await resumeGame(samplePool, setup, half);

    assert.deepEqual(b.pending, a.pending);
    assert.deepEqual(b.views.P1, a.views.P1);
    assert.deepEqual(b.views.P2, a.views.P2);
    assert.equal(b.engine.state.rng, a.engine.state.rng, '乱数の位置まで一致する');
  });

  it('1手ずつ足していくと、途中で止めた盤面が最後まで繋がる', async () => {
    const setup = setupOf();
    const { choices, last } = await playOut(setup);

    assert.ok(choices.length > 10, `選択が集まる（${choices.length}件）`);
    assert.ok(last.result, '決着する');
    assert.equal(last.pending, undefined, '決着後は入力待ちにならない');
  });

  it('出来上がった記録が replayGame をそのまま通る', async () => {
    const setup = setupOf();
    const { choices, last } = await playOut(setup);
    const state = last.engine.state;
    const record: GameRecord = {
      version: RECORD_VERSION,
      setup,
      choices,
      log: last.engine.log,
      result: {
        cycles: state.cycle,
        ...(state.winner !== undefined ? { winner: state.winner } : {}),
        ...(state.winReason !== undefined ? { reason: state.winReason } : {}),
      },
    };

    const replayed = await replayGame(samplePool, record);
    assert.deepEqual(replayed.diff, [], '食い違いなし');
    assert.equal(replayed.consumed, choices.length, '選択を全部読み切る');
  });

  it('記録がずれていたら黙って進めずに落ちる', async () => {
    const setup = setupOf();
    const res = await resumeGame(samplePool, setup, []);
    const wrong: RecordedChoice[] = [
      { t: 'confirm', player: res.pending!.player, prompt: 'ありもしない問い', value: true },
    ];
    const out = await resumeGame(samplePool, setup, wrong);
    assert.match(out.error ?? '', /記録がずれている/);
  });
});

describe('answerToChoice', () => {
  const select: PendingRequest = {
    index: 0,
    t: 'select',
    player: 'P1',
    kind: 'card',
    prompt: '選ぶ',
    options: ['あ', 'い', 'う'],
    min: 1,
    max: 2,
  };

  it('番号をラベルつきの記録に直す', () => {
    const rec = answerToChoice(select, [2, 0]);
    assert.deepEqual(rec, {
      t: 'select',
      player: 'P1',
      kind: 'card',
      prompt: '選ぶ',
      picked: [2, 0],
      labels: ['う', 'あ'],
    });
  });

  it('範囲外・重複・件数違反・型違いを拒む', () => {
    assert.throws(() => answerToChoice(select, [3]), ResumeError);
    assert.throws(() => answerToChoice(select, [1, 1]), ResumeError);
    assert.throws(() => answerToChoice(select, []), ResumeError);
    assert.throws(() => answerToChoice(select, [0, 1, 2]), ResumeError);
    assert.throws(() => answerToChoice(select, true), ResumeError);
  });

  it('order はすべてを1回ずつ並べさせる', () => {
    const order: PendingRequest = { index: 0, t: 'order', player: 'P2', kind: 'stack', prompt: '並べる', options: ['あ', 'い'] };
    assert.deepEqual(answerToChoice(order, [1, 0]).t, 'order');
    assert.throws(() => answerToChoice(order, [0]), ResumeError);
  });

  it('number は整数と範囲を見る', () => {
    const num: PendingRequest = { index: 0, t: 'number', player: 'P1', prompt: 'いくつ', min: 1, max: 3 };
    assert.equal(answerToChoice(num, 2).t, 'number');
    assert.throws(() => answerToChoice(num, 0), ResumeError);
    assert.throws(() => answerToChoice(num, 4), ResumeError);
    assert.throws(() => answerToChoice(num, 1.5), ResumeError);
  });

  it('confirm は真偽だけ', () => {
    const c: PendingRequest = { index: 0, t: 'confirm', player: 'P1', prompt: 'やる？' };
    assert.equal(answerToChoice(c, false).t, 'confirm');
    assert.throws(() => answerToChoice(c, [0]), ResumeError);
  });
});
