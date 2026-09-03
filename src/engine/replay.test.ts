/**
 * 記録と再生。
 * 「シードが同じなら同じ試合になる」「記録した試合はそのまま再現できる」
 * 「エンジンの挙動が変わったら再生が失敗する」の3点を担保する。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { samplePool } from '../rules/cards.sample';
import { loadDeck } from '../rules/decks.load';
import { AutoChooser } from './chooser';
import {
  ReplayChooser,
  ReplayError,
  assertReplayMatches,
  formatChoices,
  formatLog,
  recordGame,
  replayGame,
  type GameRecord,
  type RunOptions,
} from './replay';
import type { God } from '../rules/types';

function opts(p1God: God, p2God: God, seed: number): RunOptions {
  return {
    pool: samplePool,
    p1God,
    p2God,
    decks: { P1: loadDeck(p1God), P2: loadDeck(p2God) },
    seed,
  };
}

async function record(p1God: God, p2God: God, seed: number): Promise<GameRecord> {
  const { record: r } = await recordGame(opts(p1God, p2God, seed));
  return r;
}

// ============================================================
// シード固定
// ============================================================

describe('シード固定', () => {
  it('同じシードなら選択もログも結果も完全に同じ', async () => {
    const a = await record('earth', 'sky', 1234);
    const b = await record('earth', 'sky', 1234);

    assert.deepEqual(b.choices, a.choices);
    assert.deepEqual(
      b.log.map((l) => l.text),
      a.log.map((l) => l.text),
    );
    assert.deepEqual(b.result, a.result);
  });

  it('シードが違えば違う試合になる', async () => {
    const a = await record('earth', 'sky', 1);
    const b = await record('earth', 'sky', 2);
    assert.notDeepEqual(
      b.log.map((l) => l.text),
      a.log.map((l) => l.text),
    );
  });
});

// ============================================================
// 全アクションのログ
// ============================================================

describe('アクションログ', () => {
  it('フェイズ・プレイ・解決・勝敗が種類つきで残る', async () => {
    const r = await record('earth', 'sky', 7);
    const kinds = new Set(r.log.filter((l) => l.kind).map((l) => l.kind));
    for (const k of ['phase', 'draw', 'reveal', 'resolve']) {
      assert.ok(kinds.has(k as never), `${k} のログが無い`);
    }
    // 行動ログにはサイクルとフェイズが必ず入っている
    for (const l of r.log.filter((x) => x.kind)) {
      assert.equal(typeof l.cycle, 'number');
      assert.ok(l.phase, 'phase が無い');
    }
    assert.ok(formatLog(r.log, { kindsOnly: true }).length > 0);
  });

  it('プレイされたカードが記録に残る', async () => {
    const r = await record('earth', 'sky', 3);
    const plays = r.log.filter((l) => l.kind === 'play');
    assert.ok(plays.length > 0, 'プレイのログが無い');
    assert.ok(plays.every((l) => l.player === 'P1' || l.player === 'P2'));
  });

  it('選択は「誰が・何を選んだか」まで残る', async () => {
    const r = await record('earth', 'sky', 3);
    assert.ok(r.choices.length > 0);
    assert.equal(formatChoices(r.choices).length, r.choices.length);
  });
});

// ============================================================
// 再生
// ============================================================

describe('リプレイ', () => {
  it('記録した試合を再生すると結果もログも一致する', async () => {
    const r = await record('earth', 'life', 55);
    const replayed = await replayGame(samplePool, r);
    assert.equal(replayed.matched, true, replayed.diff.join(' / '));
    assert.equal(replayed.consumed, replayed.total);
    assert.doesNotThrow(() => assertReplayMatches(replayed));
  });

  it('打ち手が違っても記録があれば再現できる（AutoChooser の試合を再生）', async () => {
    const { record: r } = await recordGame({ ...opts('sky', 'life', 9), chooser: new AutoChooser() });
    const replayed = await replayGame(samplePool, r);
    assert.equal(replayed.matched, true, replayed.diff.join(' / '));
  });

  it('例外で終わった試合も記録・再生できる', async () => {
    const { record: r } = await recordGame({ ...opts('earth', 'sky', 4), budget: 0 });
    assert.ok(r.result.error, 'エラーが記録されていない');
    const replayed = await replayGame(samplePool, r);
    assert.equal(replayed.result.error, r.result.error);
    assert.equal(replayed.matched, true, replayed.diff.join(' / '));
  });

  it('記録が足りなければ ReplayError', async () => {
    const r = await record('earth', 'sky', 12);
    const broken: GameRecord = { ...r, choices: r.choices.slice(0, 2) };
    await assert.rejects(
      async () => {
        const res = await replayGame(samplePool, broken);
        assertReplayMatches(res);
      },
      (e: Error) => e instanceof ReplayError,
    );
  });

  it('記録の版が違えば拒否する', async () => {
    const r = await record('earth', 'sky', 13);
    await assert.rejects(() => replayGame(samplePool, { ...r, version: 999 }), ReplayError);
  });

  it('求められた選択が記録と違えば ReplayError（ずれの検出）', async () => {
    const chooser = new ReplayChooser([
      { t: 'confirm', player: 'P1', prompt: '別のことを聞かれた', value: true },
    ]);
    await assert.rejects(
      () =>
        chooser.select({
          kind: 'card',
          player: 'P1',
          prompt: 'プレイするカードを選ぶ',
          options: [{ value: 1, label: 'a' }],
          min: 0,
          max: 1,
        }),
      ReplayError,
    );
  });

  it('選択肢の中身が変わっていれば ReplayError（退行の検出）', async () => {
    const chooser = new ReplayChooser([
      { t: 'select', player: 'P1', kind: 'card', prompt: '選ぶ', picked: [0], labels: ['斬撃'] },
    ]);
    await assert.rejects(
      () =>
        chooser.select({
          kind: 'card',
          player: 'P1',
          prompt: '選ぶ',
          options: [{ value: 1, label: '刺突' }],
          min: 1,
          max: 1,
        }),
      ReplayError,
    );
  });
});
