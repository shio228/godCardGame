/**
 * 企画書由来の勝利条件データ（`src/rules/objectives.sample.ts`）の検証。
 *
 * `objectives.test.ts` がエンジンの仕組みを見るのに対し、こちらは**データ**を見る。
 * カードの `npm run sweep` に相当する煙テスト（全条件が例外なく評価できる）と、
 * 代表的な条件を実際に成立させるゴールデンテストを置いている。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { samplePool } from '../rules/cards.sample';
import { sampleObjectives } from '../rules/objectives.sample';
import { ScriptedChooser, type ScriptedAnswer } from './chooser';
import { Scope, type Ctx, type Engine } from './context';
import { evalCondition } from './condition';
import { resolveTop } from './effects';
import { createEngine, endTurn, startCycle, topCtx } from './flow';
import { setupObjectives } from './objectives';
import { nextUid } from './state';
import type { God, ObjectiveDef } from '../rules/types';

const GODS: God[] = ['earth', 'sea', 'sky', 'life'];

function byGod(god: God): ObjectiveDef[] {
  return sampleObjectives.filter((o) => o.god === god);
}

function idsOf(god: God): string[] {
  return byGod(god).map((o) => o.id);
}

function label(o: ObjectiveDef): string {
  return `${o.name}（先行度${o.initiative}）`;
}

function setup(p1God: God, p2God: God, answers: ScriptedAnswer[] = []): Engine {
  return createEngine({ pool: samplePool, p1God, p2God, cycle: 0, chooser: new ScriptedChooser(answers) });
}

/** 両者が自分の神の3つを採用した状態を作る */
function setupBoth(engine: Engine, p1God: God, p2God: God): void {
  setupObjectives(engine, 'P1', idsOf(p1God));
  setupObjectives(engine, 'P2', idsOf(p2God));
}

function pick(...objectives: ObjectiveDef[]): ScriptedAnswer[] {
  return objectives.map((o) => ({ selectLabels: [label(o)] }));
}

const [earthTen, earthArsenal, earthBlow] = byGod('earth') as [ObjectiveDef, ObjectiveDef, ObjectiveDef];
const [seaChant, seaHand, seaLife] = byGod('sea') as [ObjectiveDef, ObjectiveDef, ObjectiveDef];
const [skyEffects, skyWeather, skyRun] = byGod('sky') as [ObjectiveDef, ObjectiveDef, ObjectiveDef];
const [lifeNinetyNine, lifeSwings, lifeAllSpecies] = byGod('life') as [ObjectiveDef, ObjectiveDef, ObjectiveDef];

// ============================================================
// データの形
// ============================================================

describe('勝利条件データの形', () => {
  it('大地・海・空・生命がちょうど3つずつ持つ（創造は未データ化）', () => {
    for (const g of GODS) assert.equal(byGod(g).length, 3, `${g} の勝利条件が3つでない`);
    assert.equal(byGod('creation').length, 0, '創造は調整中のため未データ化');
    assert.equal(sampleObjectives.length, 12);
  });

  it('先行度は全神を通して一意（「先行度は同じ数字を持たない」）', () => {
    const inits = sampleObjectives.map((o) => o.initiative);
    assert.equal(new Set(inits).size, inits.length, `先行度が重複している: ${inits.join(', ')}`);
  });

  it('id と名前が重複しない', () => {
    assert.equal(new Set(sampleObjectives.map((o) => o.id)).size, 12);
    assert.equal(new Set(sampleObjectives.map((o) => o.name)).size, 12);
  });

  it('企画書の仮配分どおりの数値になっている', () => {
    const of = (g: God) => byGod(g).map((o) => o.initiative).sort((a, b) => Number(a) - Number(b));
    assert.deepEqual(of('earth'), [1, 3, 6]);
    assert.deepEqual(of('life'), [2, 8, 12]);
    assert.deepEqual(of('sky'), [4, 7, 9]);
    assert.deepEqual(of('sea'), [5, 10, 15]);
  });

  it('どの神も自分の3つをそのまま採用できる', () => {
    for (const g of GODS) {
      const engine = setup(g, g);
      assert.doesNotThrow(() => setupObjectives(engine, 'P1', idsOf(g)));
      assert.equal(engine.state.players.P1.objectives.length, 3);
    }
  });
});

// ============================================================
// 煙テスト — 全条件が空盤面で例外なく評価できる
// ============================================================

describe('全条件の評価（sweep 相当）', () => {
  it('12件すべてが空盤面で例外なく評価でき、どれも成立しない', async () => {
    const engine = setup('earth', 'sea');
    const failures: string[] = [];

    for (const o of sampleObjectives) {
      if (!o.cond) continue;
      // 誘発型の条件は暗黙束縛を参照しうるので、0 を入れた状態で評価する
      const vars = new Scope();
      vars.set('amount', { of: 'number', value: 0 });
      vars.set('count', { of: 'number', value: 0 });
      vars.set('delta', { of: 'number', value: 0 });
      const ctx: Ctx = { engine, self: 'P1', vars };
      try {
        const met = await evalCondition(o.cond, ctx);
        if (met) failures.push(`${o.name}: 空盤面で成立してしまう`);
      } catch (e) {
        failures.push(`${o.name}: ${(e as Error).name}: ${(e as Error).message}`);
      }
    }

    assert.deepEqual(failures, []);
  });
});

// ============================================================
// 実際に成立させる
// ============================================================

describe('大地', () => {
  it('一撃必殺 — 1度の攻撃で8点通ったら勝利', async () => {
    const engine = setup('earth', 'sea', pick(earthBlow, seaChant));
    setupBoth(engine, 'earth', 'sea');
    await startCycle(engine);

    await resolveTop(
      { t: 'damage', to: { t: 'player', who: { t: 'opponent' } }, amount: 8, flags: { ignoreCycleBonus: true } },
      topCtx(engine, 'P1'),
    );
    assert.equal(engine.state.winner, 'P1');
  });

  it('一撃必殺 — 相手が軽減して8点未満なら成立しない', async () => {
    const engine = setup('earth', 'sea', pick(earthBlow, seaChant));
    setupBoth(engine, 'earth', 'sea');
    await startCycle(engine);
    engine.state.players.P2.status.reduction = 3;

    await resolveTop(
      { t: 'damage', to: { t: 'player', who: { t: 'opponent' } }, amount: 7, flags: { ignoreCycleBonus: true } },
      topCtx(engine, 'P1'),
    );
    assert.equal(engine.state.winner, undefined, 'amount は通ったダメージなので 8-3=5');
  });

  it('完全武装の証明 — 装備を全種そろえて打撃したら勝利', async () => {
    const engine = setup('earth', 'sea', pick(earthArsenal, seaChant));
    setupBoth(engine, 'earth', 'sea');
    await startCycle(engine);

    const strike = () =>
      resolveTop(
        { t: 'damage', to: { t: 'player', who: { t: 'opponent' } }, amount: 2, tags: ['strike'], flags: { ignoreCycleBonus: true } },
        topCtx(engine, 'P1'),
      );

    await strike();
    assert.equal(engine.state.winner, undefined, '装備が無ければ成立しない');

    for (const defId of ['earth/sword', 'earth/spear', 'earth/hammer', 'earth/armor_obsidian', 'earth/armor_mantle']) {
      engine.state.players.P1.tokens.push({
        uid: nextUid(engine.state, 'TK'),
        defId,
        owner: 'P1',
        equipped: true,
      });
    }
    await strike();
    assert.equal(engine.state.winner, 'P1');
  });

  it('完全武装の証明 — 打撃以外のダメージでは成立しない', async () => {
    const engine = setup('earth', 'sea', pick(earthArsenal, seaChant));
    setupBoth(engine, 'earth', 'sea');
    await startCycle(engine);
    for (const defId of ['earth/sword', 'earth/spear', 'earth/hammer', 'earth/armor_obsidian', 'earth/armor_mantle']) {
      engine.state.players.P1.tokens.push({ uid: nextUid(engine.state, 'TK'), defId, owner: 'P1', equipped: true });
    }

    await resolveTop(
      { t: 'damage', to: { t: 'player', who: { t: 'opponent' } }, amount: 2, tags: ['slash'], flags: { ignoreCycleBonus: true } },
      topCtx(engine, 'P1'),
    );
    assert.equal(engine.state.winner, undefined);
  });

  it('十連撃の誓約 — 10回目のダメージで勝利', async () => {
    const engine = setup('earth', 'sea', pick(earthTen, seaChant));
    setupBoth(engine, 'earth', 'sea');
    await startCycle(engine);

    for (let i = 0; i < 9; i++) {
      await resolveTop(
        { t: 'damage', to: { t: 'minion', species: 'human', owner: { t: 'opponent' } }, amount: 1, flags: { ignoreCycleBonus: true } },
        topCtx(engine, 'P1'),
      );
    }
    assert.equal(engine.state.winner, undefined, '9回ではまだ');

    await resolveTop(
      { t: 'damage', to: { t: 'minion', species: 'human', owner: { t: 'opponent' } }, amount: 1, flags: { ignoreCycleBonus: true } },
      topCtx(engine, 'P1'),
    );
    assert.equal(engine.state.winner, 'P1');
  });
});

describe('海', () => {
  it('完全なる水位 — サイクル開始時にライフちょうど35で勝利', async () => {
    const engine = setup('sea', 'sky', pick(seaLife, skyRun));
    setupBoth(engine, 'sea', 'sky');
    engine.state.players.P1.life = 35;

    await startCycle(engine);
    assert.equal(engine.state.winner, 'P1');
  });

  it('完全なる水位 — 36では成立しない', async () => {
    const engine = setup('sea', 'sky', pick(seaLife, skyRun));
    setupBoth(engine, 'sea', 'sky');
    engine.state.players.P1.life = 36;

    await startCycle(engine);
    assert.equal(engine.state.winner, undefined);
  });

  it('叡智の飽和 — ターン終了時に手札ちょうど15枚で勝利', async () => {
    const engine = setup('sea', 'sky', pick(seaHand, skyRun));
    setupBoth(engine, 'sea', 'sky');
    await startCycle(engine);

    const hand = engine.state.players.P1.zones.hand[0]!;
    for (let i = 0; i < 15; i++) {
      hand.push({ uid: nextUid(engine.state, 'C'), defId: 'sea/future_choice', owner: 'P1' });
    }
    await endTurn(engine);
    assert.equal(engine.state.winner, 'P1');
  });

  it('詠唱の極致 — スタック上の詠唱合計が30以上で勝利', async () => {
    const engine = setup('sea', 'sky', pick(seaChant, skyRun));
    setupBoth(engine, 'sea', 'sky');
    await startCycle(engine);

    // 詠唱を持つカードを1枚スタックに乗せ（初期値1）、カウンターを積み上げる
    // （ドローフェイズを飛ばしているので、スタックフェイズに入った状態を直接作る）
    engine.state.phase = 'stack';
    const { play, putInHand } = await import('./flow');
    const [c] = putInHand(engine, 'P1', ['sea/domain_expansion']);
    const item = await play(engine, 'P1', c!);
    assert.equal(engine.state.winner, undefined);

    await resolveTop(
      { t: 'addCounter', kind: 'chant', on: { t: 'this' }, amount: 29 },
      { engine, self: 'P1', item, stackId: item.stackId, vars: new Scope() },
    );
    assert.equal(item.counters.chant, 30);
    assert.equal(engine.state.winner, 'P1');
  });
});

describe('空', () => {
  it('天象二十変 — 累計20回の天候変化で勝利', async () => {
    const engine = setup('sky', 'earth', pick(skyWeather, earthBlow));
    setupBoth(engine, 'sky', 'earth');
    await startCycle(engine);

    for (let i = 0; i < 19; i++) {
      await resolveTop({ t: 'setWeather', weather: i % 2 === 0 ? 'rain' : 'clear' }, topCtx(engine, 'P1'));
    }
    assert.equal(engine.state.winner, undefined, '19回ではまだ');

    await resolveTop({ t: 'setWeather', weather: 'blizzard' }, topCtx(engine, 'P1'));
    assert.equal(engine.state.winner, 'P1');
  });

  it('無限連鎖 — 自分の効果がスタックに15個並んだら勝利', async () => {
    const engine = setup('sky', 'earth', pick(skyEffects, earthBlow));
    setupBoth(engine, 'sky', 'earth');
    await startCycle(engine);

    const push = (times: number) =>
      resolveTop(
        {
          t: 'addToStack',
          payload: { t: 'effect', text: 'なにもしない', effect: { t: 'seq', of: [] } },
          times,
        },
        topCtx(engine, 'P1'),
      );

    await push(14);
    assert.equal(engine.state.stacks[0]!.items.length, 14);
    assert.equal(engine.state.winner, undefined, '14個ではまだ');

    await push(1);
    assert.equal(engine.state.winner, 'P1');
  });

  it('無限連鎖 — 相手の効果は数えない', async () => {
    const engine = setup('sky', 'earth', pick(skyEffects, earthBlow));
    setupBoth(engine, 'sky', 'earth');
    await startCycle(engine);

    await resolveTop(
      {
        t: 'addToStack',
        payload: { t: 'effect', text: 'なにもしない', effect: { t: 'seq', of: [] } },
        times: 20,
      },
      topCtx(engine, 'P2'),
    );
    assert.equal(engine.state.winner, undefined);
  });

  it('連鎖する空 — 自分の項目がスタック上で7つ連続したら勝利', async () => {
    const engine = setup('sky', 'earth', pick(skyRun, earthBlow));
    setupBoth(engine, 'sky', 'earth');
    await startCycle(engine);

    const push = (who: 'P1' | 'P2', times: number) =>
      resolveTop(
        {
          t: 'addToStack',
          payload: { t: 'effect', text: 'なにもしない', effect: { t: 'seq', of: [] } },
          times,
        },
        topCtx(engine, who),
      );

    // 相手の項目を挟むと連続が切れる
    await push('P1', 4);
    await push('P2', 1);
    await push('P1', 6);
    assert.equal(engine.state.winner, undefined, '一番上から数えて6つしか続いていない');

    await push('P1', 1);
    assert.equal(engine.state.winner, 'P1');
  });

  it('天象二十変 — 相手が変えた天候も数える（by 未指定）', async () => {
    const engine = setup('sky', 'earth', pick(skyWeather, earthBlow));
    setupBoth(engine, 'sky', 'earth');
    await startCycle(engine);

    for (let i = 0; i < 20; i++) {
      await resolveTop({ t: 'setWeather', weather: i % 2 === 0 ? 'rain' : 'clear' }, topCtx(engine, 'P2'));
    }
    assert.equal(engine.state.winner, 'P1', '空のプレイヤーは動いていないが条件は満たされる');
  });
});

describe('生命', () => {
  it('生命の氾濫 — サイクル開始時にライフ99以上で勝利', async () => {
    const engine = setup('life', 'sea', pick(lifeNinetyNine, seaChant));
    setupBoth(engine, 'life', 'sea');
    engine.state.players.P1.life = 99;

    await startCycle(engine);
    assert.equal(engine.state.winner, 'P1');
  });

  it('万象の軍勢 — 4種類それぞれ5体以上そろったら勝利', async () => {
    const engine = setup('life', 'sea', pick(lifeAllSpecies, seaChant));
    setupBoth(engine, 'life', 'sea');
    await startCycle(engine);

    // 生命の神パッシブで開始時に全種2体ずつ。1種だけ足りない状態を作る
    engine.state.players.P1.minions = { human: 5, angel: 5, wraith: 5, beast: 4 };
    await endTurn(engine);
    assert.equal(engine.state.winner, undefined, '獣が4体では成立しない');

    engine.state.players.P1.minions.beast = 5;
    await endTurn(engine);
    assert.equal(engine.state.winner, 'P1');
  });

  it('万象の軍勢 — 合計数が多くても1種欠けていれば成立しない', async () => {
    const engine = setup('life', 'sea', pick(lifeAllSpecies, seaChant));
    setupBoth(engine, 'life', 'sea');
    await startCycle(engine);

    engine.state.players.P1.minions = { human: 40, angel: 40, wraith: 40, beast: 0 };
    await endTurn(engine);
    assert.equal(engine.state.winner, undefined);
  });

  it('生死の振幅 — 両者のライフ変動を合計50回で勝利', async () => {
    const engine = setup('life', 'sea', pick(lifeSwings, seaChant));
    setupBoth(engine, 'life', 'sea');
    await startCycle(engine);

    const before = engine.state.events.filter((e) => e.kind === 'lifeChanged').length;
    for (let i = 0; i < 50 - before - 1; i++) {
      await resolveTop({ t: 'heal', to: { t: 'opponent' }, amount: 1 }, topCtx(engine, 'P1'));
    }
    assert.equal(engine.state.winner, undefined, '49回ではまだ');

    await resolveTop({ t: 'heal', to: { t: 'opponent' }, amount: 1 }, topCtx(engine, 'P1'));
    assert.equal(engine.state.winner, 'P1', '相手のライフ変動でも数える');
  });
});

// ============================================================
// 公開と先攻決定（実データで）
// ============================================================

describe('実データでの先攻決定', () => {
  it('大地(1) vs 海(5) は大地が先攻', async () => {
    const engine = setup('earth', 'sea', pick(earthTen, seaChant));
    setupBoth(engine, 'earth', 'sea');
    engine.state.first = 'P2';
    await startCycle(engine);
    assert.equal(engine.state.first, 'P1');
  });

  it('空(9) vs 生命(2) は生命が先攻', async () => {
    const engine = setup('sky', 'life', pick(skyRun, lifeNinetyNine));
    setupBoth(engine, 'sky', 'life');
    await startCycle(engine);
    assert.equal(engine.state.first, 'P2');
  });

  it('どの神の組み合わせ・どの公開順でも先行度が並ぶことはない', () => {
    const pairs: [God, God][] = [];
    for (const a of GODS) for (const b of GODS) if (a !== b) pairs.push([a, b]);
    for (const [a, b] of pairs) {
      for (const x of byGod(a)) {
        for (const y of byGod(b)) {
          assert.notEqual(x.initiative, y.initiative, `${x.name} と ${y.name} の先行度が並ぶ`);
        }
      }
    }
  });
});
