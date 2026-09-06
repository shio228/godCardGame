/**
 * 特殊勝利条件（ObjectiveDef）の公開と評価ループのテスト。
 *
 * 設定シートの勝利条件はまだデータ化していないので（企画側の次の宿題）、
 * ここでは設定シートの文面をそのまま写した**テスト用の条件**を使う。
 * 数値・先行度も設定シートの仮配分に合わせてある。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { samplePool } from '../rules/cards.sample';
import { ScriptedChooser, type ScriptedAnswer } from './chooser';
import { Scope, type Ctx, type Engine } from './context';
import { RuleError } from './errors';
import { resolveTop } from './effects';
import { createEngine, endTurn, startCycle, topCtx } from './flow';
import { revealObjectiveById, setupObjectives } from './objectives';
import type { CardPool, God, ObjectiveDef, PlayerId } from '../rules/types';

// ============================================================
// テスト用の勝利条件（設定シート「基本システム」の文面より）
// ============================================================

const testObjectives: ObjectiveDef[] = [
  // --- 大地 先行度配分 1 / 3 / 6 ---
  {
    id: 'earth/obj_burst',
    name: '一撃必殺',
    god: 'earth',
    initiative: 6,
    text: 'あなたが1度の攻撃で8点のダメージを与えたなら勝利する。',
    when: { on: 'damageDealt' },
    cond: { t: 'cmp', a: { t: 'var', name: 'amount' }, op: '>=', b: 8 },
  },
  {
    id: 'earth/obj_offense',
    name: '攻勢の誓い',
    god: 'earth',
    initiative: 1,
    text: '＜常在＞あなたの与えるダメージは＋1となる。',
    when: { on: 'continuous' },
    // 勝利条件そのものではなく、公開されている間だけ働くパッシブ
    cond: { t: 'cmp', a: 0, op: '==', b: 1 }, // 決して成立しない＝勝利判定はしない
    passive: { t: 'damageDelta', amount: 1, who: { t: 'self' }, direction: 'dealt' },
  },
  {
    id: 'earth/obj_unbroken',
    name: '無傷の証明',
    god: 'earth',
    initiative: 3,
    text: 'このターン発生したダメージを全て0まで軽減できたら勝利する。',
    when: { on: 'turnEnd' },
    cond: {
      t: 'cmp',
      a: { t: 'countEvent', event: 'damageTaken', scope: 'turn', measure: 'units', by: { t: 'self' } },
      op: '==',
      b: 0,
    },
  },

  // --- 海 先行度配分 5 / 10 / 15 ---
  {
    id: 'sea/obj_life35',
    name: '完全なる水位',
    god: 'sea',
    initiative: 10,
    text: 'あなたのライフがちょうど35なら勝利する。',
    when: { on: 'continuous' },
    cond: { t: 'cmp', a: { t: 'life', of: { t: 'self' } }, op: '==', b: 35 },
  },
  {
    id: 'sea/obj_chant30',
    name: '詠唱の極致',
    god: 'sea',
    initiative: 5,
    text: 'スタック上で詠唱の合計数が30以上になったら勝利する。',
    when: { on: 'counterChanged' },
    cond: { t: 'cmp', a: { t: 'countStack' }, op: '>=', b: 99 }, // 到達しない値にしてある
  },
  {
    id: 'sea/obj_tide',
    name: '潮位の観測',
    god: 'sea',
    initiative: 15,
    text: 'あなたのライフが変動するたび、1点回復する。',
    when: { on: 'continuous' },
    cond: { t: 'cmp', a: { t: 'life', of: { t: 'self' } }, op: '<=', b: 20 },
    // 勝利しない条件（創造の神のような「効果を持つ条件」の代表）
    effect: { t: 'heal', to: { t: 'self' }, amount: 5 },
    limit: { count: 1, per: 'turn' },
  },
  {
    id: 'sea/obj_undertow',
    name: '底流の加護',
    god: 'sea',
    initiative: 12,
    text: '＜常在＞あなたの与えるダメージは＋1となる。',
    when: { on: 'continuous' },
    cond: { t: 'cmp', a: 0, op: '==', b: 1 }, // 決して成立しない＝勝利判定はしない
    passive: { t: 'damageDelta', amount: 1, who: { t: 'self' }, direction: 'dealt' },
  },
];

const pool: CardPool = { ...samplePool, objectives: testObjectives };

function setup(p1God: God, p2God: God, answers: ScriptedAnswer[] = []): Engine {
  return createEngine({
    pool,
    p1God,
    p2God,
    cycle: 0,
    chooser: new ScriptedChooser(answers),
  });
}

function ctxOf(engine: Engine, self: PlayerId): Ctx {
  return { engine, self, vars: new Scope() };
}

/** 選択肢のラベルで公開する条件を指定する（順序に依存しないため） */
function pick(...names: string[]): ScriptedAnswer[] {
  return names.map((n) => ({ selectLabels: [n] }));
}

const EARTH_3 = ['earth/obj_burst', 'earth/obj_offense', 'earth/obj_unbroken'];
const SEA_3 = ['sea/obj_life35', 'sea/obj_chant30', 'sea/obj_tide'];

// ============================================================
// 採用（デッキ構築時の検査）
// ============================================================

describe('勝利条件の採用', () => {
  it('3つ未満は採用できない', () => {
    const engine = setup('earth', 'sea');
    assert.throws(() => setupObjectives(engine, 'P1', EARTH_3.slice(0, 2)), RuleError);
  });

  it('他の神の勝利条件は採用できない', () => {
    const engine = setup('earth', 'sea');
    assert.throws(() => setupObjectives(engine, 'P1', ['earth/obj_burst', 'earth/obj_offense', 'sea/obj_life35']), RuleError);
  });

  it('先行度が重複していたら採用時に弾く', () => {
    const dup: ObjectiveDef = { ...testObjectives[0]!, id: 'earth/obj_dup', initiative: 1 };
    const engine = createEngine({
      pool: { ...pool, objectives: [...testObjectives, dup] },
      p1God: 'earth',
      p2God: 'sea',
    });
    assert.throws(
      () => setupObjectives(engine, 'P1', ['earth/obj_offense', 'earth/obj_dup', 'earth/obj_burst']),
      RuleError,
    );
  });

  it('採用した条件はすべて伏せた状態から始まる', () => {
    const engine = setup('earth', 'sea');
    setupObjectives(engine, 'P1', EARTH_3);
    assert.equal(engine.state.players.P1.objectives.length, 3);
    assert.equal(engine.state.players.P1.revealedObjectives.length, 0);
  });
});

// ============================================================
// 公開と先攻決定
// ============================================================

describe('公開と先攻決定', () => {
  it('サイクル開始に1つずつ公開され、先行度が1に近い方が先攻になる', async () => {
    // P1(大地) は先行度3、P2(海) は先行度5 を公開 → P1 が先攻
    const engine = setup('earth', 'sea', pick('無傷の証明（先行度3）', '詠唱の極致（先行度5）'));
    setupObjectives(engine, 'P1', EARTH_3);
    setupObjectives(engine, 'P2', SEA_3);
    engine.state.first = 'P2';

    await startCycle(engine);

    assert.deepEqual(engine.state.players.P1.revealedObjectives, ['earth/obj_unbroken']);
    assert.deepEqual(engine.state.players.P2.revealedObjectives, ['sea/obj_chant30']);
    assert.equal(engine.state.players.P1.objectives.length, 2, '公開した分だけ伏せ札が減る');
    assert.equal(engine.state.first, 'P1');
  });

  it('サイクルごとに公開が進み、そのつど先攻が入れ替わる', async () => {
    const engine = setup(
      'earth',
      'sea',
      pick(
        '無傷の証明（先行度3）', '完全なる水位（先行度10）',  // 3 < 10 → P1
        '一撃必殺（先行度6）', '詠唱の極致（先行度5）',        // 6 > 5  → P2
        '攻勢の誓い（先行度1）', '潮位の観測（先行度15）',      // 1 < 15 → P1
      ),
    );
    setupObjectives(engine, 'P1', EARTH_3);
    setupObjectives(engine, 'P2', SEA_3);

    await startCycle(engine);
    assert.equal(engine.state.first, 'P1');
    await startCycle(engine);
    assert.equal(engine.state.first, 'P2');
    await startCycle(engine);
    assert.equal(engine.state.first, 'P1');
  });

  it('公開し尽くしたあとは最後に公開した条件の値で固定される', async () => {
    const engine = setup(
      'earth',
      'sea',
      pick(
        '無傷の証明（先行度3）', '完全なる水位（先行度10）',
        '攻勢の誓い（先行度1）', '詠唱の極致（先行度5）',
        '一撃必殺（先行度6）', '潮位の観測（先行度15）',        // 6 < 15 → P1
      ),
    );
    setupObjectives(engine, 'P1', EARTH_3);
    setupObjectives(engine, 'P2', SEA_3);

    for (let i = 0; i < 3; i++) await startCycle(engine);
    assert.equal(engine.state.first, 'P1');
    assert.equal(engine.state.players.P1.objectives.length, 0);

    // サイクル3以降 — 公開は起きず、最後の 6 vs 15 のまま
    await startCycle(engine);
    await startCycle(engine);
    assert.equal(engine.state.first, 'P1');
    assert.equal(engine.state.cycle, 5);
  });

  it('公開は objectiveRevealed として誘発できる', async () => {
    const engine = setup('earth', 'sea', pick('無傷の証明（先行度3）', '詠唱の極致（先行度5）'));
    setupObjectives(engine, 'P1', EARTH_3);
    setupObjectives(engine, 'P2', SEA_3);
    await startCycle(engine);

    const revealed = engine.state.events.filter((e) => e.kind === 'objectiveRevealed');
    assert.equal(revealed.length, 2);
    assert.deepEqual(
      revealed.map((e) => e.objectiveId),
      ['earth/obj_unbroken', 'sea/obj_chant30'],
    );
  });
});

// ============================================================
// 誘発型の判定
// ============================================================

describe('誘発型の勝利条件', () => {
  it('公開されていれば成立して勝利する（8点で一撃必殺）', async () => {
    const engine = setup('earth', 'sea', pick('一撃必殺（先行度6）', '詠唱の極致（先行度5）'));
    setupObjectives(engine, 'P1', EARTH_3);
    setupObjectives(engine, 'P2', SEA_3);
    await startCycle(engine);

    await resolveTop(
      { t: 'damage', to: { t: 'player', who: { t: 'opponent' } }, amount: 8, flags: { ignoreCycleBonus: true } },
      topCtx(engine, 'P1'),
    );
    assert.equal(engine.state.winner, 'P1', 'ちょうど8点');
  });

  it('条件を満たさなければ勝利しない（7点）', async () => {
    const engine = setup('earth', 'sea', pick('一撃必殺（先行度6）', '詠唱の極致（先行度5）'));
    setupObjectives(engine, 'P1', EARTH_3);
    setupObjectives(engine, 'P2', SEA_3);
    await startCycle(engine);

    await resolveTop(
      { t: 'damage', to: { t: 'player', who: { t: 'opponent' } }, amount: 7, flags: { ignoreCycleBonus: true } },
      topCtx(engine, 'P1'),
    );
    assert.equal(engine.state.winner, undefined, '7点では届かない');
  });

  it('公開していない条件は成立しない（伏せたままの一撃必殺）', async () => {
    const engine = setup('earth', 'sea', pick('無傷の証明（先行度3）', '詠唱の極致（先行度5）'));
    setupObjectives(engine, 'P1', EARTH_3);
    setupObjectives(engine, 'P2', SEA_3);
    await startCycle(engine);

    await resolveTop(
      { t: 'damage', to: { t: 'player', who: { t: 'opponent' } }, amount: 20, flags: { ignoreCycleBonus: true } },
      topCtx(engine, 'P1'),
    );
    assert.equal(engine.state.winner, undefined, '一撃必殺はまだ伏せてある');
  });

  it('終了フェイズを見る条件は endTurn で判定される（無傷の証明）', async () => {
    const engine = setup('earth', 'sea', pick('無傷の証明（先行度3）', '詠唱の極致（先行度5）'));
    setupObjectives(engine, 'P1', EARTH_3);
    setupObjectives(engine, 'P2', SEA_3);
    await startCycle(engine);

    await endTurn(engine);
    assert.equal(engine.state.winner, 'P1', 'このターン1点も受けていない');
  });

  it('ダメージを受けていたら成立しない', async () => {
    const engine = setup('earth', 'sea', pick('無傷の証明（先行度3）', '詠唱の極致（先行度5）'));
    setupObjectives(engine, 'P1', EARTH_3);
    setupObjectives(engine, 'P2', SEA_3);
    await startCycle(engine);

    // 大地の「難攻不落」でターン開始時にシールド5が乗るので、それを超える値を与える
    await resolveTop(
      { t: 'damage', to: { t: 'player', who: { t: 'opponent' } }, amount: 8, flags: { ignoreCycleBonus: true } },
      topCtx(engine, 'P2'),
    );
    await endTurn(engine);
    assert.equal(engine.state.winner, undefined);
  });
});

// ============================================================
// 状況起因型の判定
// ============================================================

describe('状況起因型の勝利条件', () => {
  it('成立した瞬間に勝利する（ライフちょうど35）', async () => {
    const engine = setup('sea', 'earth', pick('完全なる水位（先行度10）', '無傷の証明（先行度3）'));
    setupObjectives(engine, 'P1', SEA_3);
    setupObjectives(engine, 'P2', EARTH_3);
    await startCycle(engine);
    assert.equal(engine.state.winner, undefined, 'ライフ30ではまだ');

    await resolveTop({ t: 'heal', to: { t: 'self' }, amount: 5 }, topCtx(engine, 'P1'));
    assert.equal(engine.state.winner, 'P1');
  });

  it('ちょうどでなければ成立しない（36）', async () => {
    const engine = setup('sea', 'earth', pick('完全なる水位（先行度10）', '無傷の証明（先行度3）'));
    setupObjectives(engine, 'P1', SEA_3);
    setupObjectives(engine, 'P2', EARTH_3);
    await startCycle(engine);

    await resolveTop({ t: 'heal', to: { t: 'self' }, amount: 6 }, topCtx(engine, 'P1'));
    assert.equal(engine.state.winner, undefined);
  });

  it('勝利以外の効果を持つ条件は effect を実行し、limit の回数で止まる', async () => {
    // P2 に「無傷の証明」を公開させると endTurn で P2 が勝ってしまうので一撃必殺にしておく
    const engine = setup('sea', 'earth', pick('潮位の観測（先行度15）', '一撃必殺（先行度6）'));
    setupObjectives(engine, 'P1', SEA_3);
    setupObjectives(engine, 'P2', EARTH_3);
    engine.state.players.P1.life = 10;
    await startCycle(engine);

    // 公開直後の判定で1回目（10 → 15）
    assert.equal(engine.state.players.P1.life, 15);
    assert.equal(engine.state.winner, undefined, 'effect を持つ条件は勝利しない');

    // 同じターン内は limit(1/turn) で止まる。成立し続けていても再発火しない
    await endTurn(engine);
    assert.equal(engine.state.players.P1.life, 15);

    // ターンが変われば枠が戻る
    await startCycle(engine);
    assert.equal(engine.state.players.P1.life, 20);
  });
});

// ============================================================
// パッシブ
// ============================================================

describe('勝利条件のパッシブ', () => {
  it('公開されている間だけ常在効果を持つ（底流の加護）', async () => {
    const engine = setup('sea', 'sea', pick('完全なる水位（先行度10）', '詠唱の極致（先行度5）'));
    setupObjectives(engine, 'P1', [...SEA_3, 'sea/obj_undertow']);
    setupObjectives(engine, 'P2', SEA_3);
    await startCycle(engine);

    await resolveTop(
      { t: 'damage', to: { t: 'player', who: { t: 'opponent' } }, amount: 3, flags: { ignoreCycleBonus: true } },
      topCtx(engine, 'P1'),
    );
    assert.equal(engine.state.players.P2.life, 27, '公開前は素の3点');

    // 底流の加護を公開状態にしてから、もう一度3点
    revealObjectiveById(engine, 'P1', 'sea/obj_undertow');
    await resolveTop(
      { t: 'damage', to: { t: 'player', who: { t: 'opponent' } }, amount: 3, flags: { ignoreCycleBonus: true } },
      topCtx(engine, 'P1'),
    );
    assert.equal(engine.state.players.P2.life, 23, 'パッシブで＋1 → 4点');
  });

  it('パッシブだけの条件は勝利判定を起こさない', async () => {
    const engine = setup('earth', 'sea', pick('攻勢の誓い（先行度1）', '詠唱の極致（先行度5）'));
    setupObjectives(engine, 'P1', EARTH_3);
    setupObjectives(engine, 'P2', SEA_3);
    await startCycle(engine);
    await endTurn(engine);
    assert.equal(engine.state.winner, undefined);
  });
});

// ============================================================
// 判定漏れがないこと
// ============================================================

describe('評価ループの網羅', () => {
  it('ctxOf を使った素の効果解決でも状況起因の判定が走る', async () => {
    const engine = setup('sea', 'earth', pick('完全なる水位（先行度10）', '無傷の証明（先行度3）'));
    setupObjectives(engine, 'P1', SEA_3);
    setupObjectives(engine, 'P2', EARTH_3);
    await startCycle(engine);

    await resolveTop({ t: 'heal', to: { t: 'self' }, amount: 5 }, ctxOf(engine, 'P1'));
    assert.equal(engine.state.winner, 'P1');
  });

  it('効果の途中で一瞬だけ成立しても勝利しない（判定は安全地点のみ）', async () => {
    const engine = setup('sea', 'earth', pick('完全なる水位（先行度10）', '無傷の証明（先行度3）'));
    setupObjectives(engine, 'P1', SEA_3);
    setupObjectives(engine, 'P2', EARTH_3);
    await startCycle(engine);

    // 30 → 35 → 135。35 は seq の途中でしか成立しない
    await resolveTop(
      {
        t: 'seq',
        of: [
          { t: 'heal', to: { t: 'self' }, amount: 5 },
          { t: 'heal', to: { t: 'self' }, amount: 100 },
        ],
      },
      topCtx(engine, 'P1'),
    );
    assert.equal(engine.state.players.P1.life, 135);
    assert.equal(engine.state.winner, undefined);
  });
});
