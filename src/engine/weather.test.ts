/**
 * 天候の能動効果（企画書「基本システム」の天候表）のゴールデンテスト。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { samplePool } from '../rules/cards.sample';
import { Scope, type Ctx, type Engine } from './context';
import { dealDamage } from './damage';
import { resolve } from './effects';
import {
  createEngine,
  endTurn,
  orderPhase,
  play,
  putInHand,
  putOnDeck,
  resolvePhase,
  startCycle,
} from './flow';
import type { Effect, God, PlayerId, Weather } from '../rules/types';

function setup(weather: Weather, opts: { p1God?: God; p2God?: God; cycle?: number } = {}): Engine {
  const engine = createEngine({
    pool: samplePool,
    p1God: opts.p1God ?? 'sea',
    p2God: opts.p2God ?? 'sky',
    weather,
    cycle: opts.cycle ?? 1,
    seed: 42,
    budget: 20000,
  });
  engine.state.phase = 'stack';
  for (const pid of ['P1', 'P2'] as PlayerId[]) {
    putOnDeck(engine, pid, new Array(12).fill('sea/future_choice'));
  }
  return engine;
}

function ctxOf(engine: Engine, self: PlayerId): Ctx {
  return { engine, self, vars: new Scope() };
}

async function grant(engine: Engine, self: PlayerId, effect: Effect): Promise<void> {
  await resolve(effect, ctxOf(engine, self));
}

const immuneTo = (weather: Weather | Weather[]): Effect => ({
  t: 'grantContinuous',
  duration: 'thisGame',
  mod: { t: 'weatherImmune', who: { t: 'self' }, weather },
});

// ============================================================
// 炎天
// ============================================================

describe('炎天', () => {
  it('カードをプレイした時、そのコントローラーに1ダメージ', async () => {
    const engine = setup('blaze');
    const [c] = putInHand(engine, 'P1', ['sea/future_choice']);
    await play(engine, 'P1', c!);
    assert.equal(engine.state.players.P1.life, 29);
    assert.equal(engine.state.players.P2.life, 30);
  });

  it('スタックを解決しようとする時にも1ダメージ（FAQ: 解決の開始時）', async () => {
    const engine = setup('blaze');
    const [c] = putInHand(engine, 'P1', ['sea/future_choice']);
    await play(engine, 'P1', c!);
    await resolvePhase(engine);
    assert.equal(engine.state.players.P1.life, 28);
  });

  it('軽減も回避もされない（天候ダメージ）', async () => {
    const engine = setup('blaze');
    engine.state.players.P1.status.reduction = 5;
    engine.state.players.P1.status.evasion = 5;
    const [c] = putInHand(engine, 'P1', ['sea/future_choice']);
    await play(engine, 'P1', c!);
    assert.equal(engine.state.players.P1.life, 29);
  });

  it('炎天の影響を受けないなら1ダメージも受けない', async () => {
    const engine = setup('blaze');
    await grant(engine, 'P1', immuneTo('blaze'));
    const [c] = putInHand(engine, 'P1', ['sea/future_choice']);
    await play(engine, 'P1', c!);
    assert.equal(engine.state.players.P1.life, 30);
  });

  it('晴・炎天は「攻撃が必ず当たる」ので回避が働かない', async () => {
    const engine = setup('clear');
    engine.state.players.P2.status.evasion = 5;
    await dealDamage(ctxOf(engine, 'P1'), {
      to: { kind: 'player', player: 'P2' },
      amount: 3,
      tags: [],
      flags: { ignoreCycleBonus: true },
      dealer: 'P1',
    });
    assert.equal(engine.state.players.P2.life, 27);
  });

  it('晴の効果を受けない側は回避できる', async () => {
    const engine = setup('clear');
    engine.state.players.P2.status.evasion = 5;
    await grant(engine, 'P2', immuneTo(['clear', 'blaze']));
    await dealDamage(ctxOf(engine, 'P1'), {
      to: { kind: 'player', player: 'P2' },
      amount: 3,
      tags: [],
      flags: { ignoreCycleBonus: true },
      dealer: 'P1',
    });
    assert.equal(engine.state.players.P2.life, 30);
  });
});

// ============================================================
// 雨 / 豪雨
// ============================================================

describe('雨・豪雨', () => {
  it('雨はサイクルダメージボーナスを乗せない', async () => {
    const engine = setup('rain', { cycle: 3 });
    await dealDamage(ctxOf(engine, 'P1'), {
      to: { kind: 'player', player: 'P2' },
      amount: 4,
      tags: [],
      flags: {},
      dealer: 'P1',
    });
    assert.equal(engine.state.players.P2.life, 26);
  });

  it('豪雨はカードをプレイするごとに手札を1枚捨てさせる', async () => {
    const engine = setup('downpour');
    putInHand(engine, 'P1', ['sea/future_choice', 'sea/future_choice']);
    const [c] = putInHand(engine, 'P1', ['sea/future_choice']);
    await play(engine, 'P1', c!);
    // 3枚 → プレイで1枚減り、豪雨でもう1枚捨てる
    assert.equal(engine.state.players.P1.zones.hand[0]!.length, 1);
    assert.equal(engine.state.players.P1.zones.graveyard[0]!.length, 1);
  });

  it('豪雨の影響を受けないなら捨てない（天水の祝福）', async () => {
    const engine = setup('downpour');
    await grant(engine, 'P1', immuneTo('downpour'));
    putInHand(engine, 'P1', ['sea/future_choice', 'sea/future_choice']);
    const [c] = putInHand(engine, 'P1', ['sea/future_choice']);
    await play(engine, 'P1', c!);
    assert.equal(engine.state.players.P1.zones.hand[0]!.length, 2);
  });
});

// ============================================================
// 吹雪
// ============================================================

describe('吹雪', () => {
  it('ターン終了時に両者へ5ダメージ（ダメボ非適用）', async () => {
    const engine = setup('blizzard', { cycle: 3 });
    await endTurn(engine);
    assert.equal(engine.state.players.P1.life, 25);
    assert.equal(engine.state.players.P2.life, 25);
  });

  it('同時死亡なら先攻が敗北する（先に死ぬから）', async () => {
    const engine = setup('blizzard');
    engine.state.first = 'P2';
    engine.state.players.P1.life = 5;
    engine.state.players.P2.life = 5;
    await endTurn(engine);
    // 先攻 P2 が先に死ぬ
    assert.equal(engine.state.winner, 'P1');
  });

  it('天候ダメージは「与えた側」を持たない — 与ダメ修正は乗らず、被ダメ修正だけ乗る', async () => {
    // 大地の「攻勢」は与ダメ+1／被ダメ+1。吹雪の5点には被ダメ分だけが乗って6になる
    const engine = setup('blizzard', { p2God: 'earth' });
    await endTurn(engine);
    assert.equal(engine.state.players.P1.life, 25);
    assert.equal(engine.state.players.P2.life, 24);
    // 「10回目のダメージを与えたなら」に天候ダメージが数え込まれないこと
    const dealt = engine.state.events.filter((e) => e.kind === 'damageDealt');
    assert.equal(dealt.length, 2);
    assert.equal(dealt.every((e) => e.player === undefined), true);
  });

  it('吹雪の影響を受けない側は受けない', async () => {
    const engine = setup('blizzard');
    await grant(engine, 'P1', immuneTo('blizzard'));
    await endTurn(engine);
    assert.equal(engine.state.players.P1.life, 30);
    assert.equal(engine.state.players.P2.life, 25);
  });
});

// ============================================================
// 雷雲
// ============================================================

describe('雷雲', () => {
  it('順番確定フェイズの終わりにスタックのカードを1枚無効化する', async () => {
    const engine = setup('thundercloud');
    const cards = putInHand(engine, 'P1', ['sea/future_choice', 'sea/future_choice']);
    for (const c of cards) await play(engine, 'P1', c);
    assert.equal(engine.state.stacks[0]!.items.length, 2);

    await orderPhase(engine);
    assert.equal(engine.state.stacks[0]!.items.length, 1);
    assert.equal(engine.state.events.some((e) => e.kind === 'weatherNegate'), true);
    assert.equal(engine.state.events.some((e) => e.kind === 'countered'), true);
  });

  it('置換効果があれば無効化されない（レイジングスカイ）', async () => {
    const engine = setup('thundercloud');
    const cards = putInHand(engine, 'P1', ['sea/future_choice', 'sea/future_choice']);
    for (const c of cards) await play(engine, 'P1', c);
    await grant(engine, 'P1', {
      t: 'grantContinuous',
      duration: 'thisCycle',
      mod: {
        t: 'replaceEvent',
        who: { t: 'self' },
        when: { on: 'weatherNegate', filter: { controller: { t: 'self' } } },
      },
    });

    await orderPhase(engine);
    assert.equal(engine.state.stacks[0]!.items.length, 2);
    assert.equal(engine.state.events.some((e) => e.kind === 'countered'), false);
  });

  it('雷雲以外の天候では無効化が起きない', async () => {
    const engine = setup('calm');
    const cards = putInHand(engine, 'P1', ['sea/future_choice', 'sea/future_choice']);
    for (const c of cards) await play(engine, 'P1', c);
    await orderPhase(engine);
    assert.equal(engine.state.stacks[0]!.items.length, 2);
  });
});

// ============================================================
// weatherChanged の暗黙束縛
// ============================================================

describe('weatherChanged', () => {
  it('from / to に実際の天候が載る（プレースホルダの0ではない）', async () => {
    const engine = setup('calm');
    await grant(engine, 'P1', { t: 'setWeather', weather: 'blaze' });
    const ev = engine.state.events.find((e) => e.kind === 'weatherChanged');
    assert.deepEqual(ev?.bindings?.from, { of: 'weather', value: 'calm' });
    assert.deepEqual(ev?.bindings?.to, { of: 'weather', value: 'blaze' });
  });
});

// ============================================================
// 終末
// ============================================================

describe('終末', () => {
  it('ターン開始時に山札の上から5枚を除外する', async () => {
    const engine = setup('calm');
    engine.state.apocalypse = true;
    const before = engine.state.players.P1.zones.deck[0]!.length;
    await startCycle(engine);
    assert.equal(engine.state.players.P1.zones.deck[0]!.length, before - 5);
    assert.equal(engine.state.players.P1.zones.exile[0]!.length, 5);
    assert.equal(engine.state.players.P2.zones.exile[0]!.length, 5);
  });

  it('終末は天候の表裏とは別枠なので、凪でも起きる', async () => {
    const engine = setup('calm');
    engine.state.apocalypse = false;
    await startCycle(engine);
    assert.equal(engine.state.players.P1.zones.exile[0]!.length, 0);
  });
});
