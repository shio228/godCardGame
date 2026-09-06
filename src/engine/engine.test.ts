/**
 * ゴールデンテスト。
 * 実在するカード・アクションを設定シート由来のデータのまま動かし、
 * 「初期状態 → 効果適用 → 期待状態」を検証する。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { samplePool } from '../rules/cards.sample';
import { AutoChooser, ScriptedChooser } from './chooser';
import { Scope, type Ctx } from './context';
import { dealDamage } from './damage';
import { drainTriggers } from './events';
import { evalValue } from './value';
import { resolve, resolveStackItem, resolveTop } from './effects';
import { createEngine, endTurn, play, putInHand, putOnDeck, resolvePhase, startCycle, topCtx } from './flow';
import type { Engine } from './context';
import type { God } from '../rules/types';

function setup(p1God: God, p2God: God, opts: { cycle?: number; chooser?: ConstructorParameters<typeof ScriptedChooser>[0] } = {}) {
  const engine = createEngine({
    pool: samplePool,
    p1God,
    p2God,
    cycle: opts.cycle ?? 0,
    ...(opts.chooser ? { chooser: new ScriptedChooser(opts.chooser) } : {}),
  });
  return engine;
}

function ctxOf(engine: Engine, self: 'P1' | 'P2'): Ctx {
  return { engine, self, vars: new Scope() };
}

// ============================================================
// ダメージパイプライン（設計書 §5）
// ============================================================

describe('ダメージパイプライン', () => {
  it('回避3 / 5ダメージ / 軽減3 → 通るのは2（回避判定は軽減前の値で行う）', async () => {
    const engine = setup('sea', 'sea');
    engine.state.players.P2.status.evasion = 3;
    engine.state.players.P2.status.reduction = 3;

    await dealDamage(ctxOf(engine, 'P1'), {
      to: { kind: 'player', player: 'P2' },
      amount: 5,
      tags: [],
      flags: {},
      dealer: 'P1',
    });

    // 軽減後の2で判定していたら 2 ≤ 3 で完封されてしまう
    assert.equal(engine.state.players.P2.life, 28);
  });

  it('回避3 / 3ダメージ → 回避が働いて0', async () => {
    const engine = setup('sea', 'sea');
    engine.state.players.P2.status.evasion = 3;

    await dealDamage(ctxOf(engine, 'P1'), {
      to: { kind: 'player', player: 'P2' },
      amount: 3,
      tags: [],
      flags: {},
      dealer: 'P1',
    });

    assert.equal(engine.state.players.P2.life, 30);
  });

  it('サイクルボーナスが乗り、雨のときは乗らない', async () => {
    const clear = setup('sea', 'sea', { cycle: 3 });
    await dealDamage(ctxOf(clear, 'P1'), {
      to: { kind: 'player', player: 'P2' },
      amount: 2,
      tags: [],
      flags: {},
      dealer: 'P1',
    });
    assert.equal(clear.state.players.P2.life, 30 - 5);

    const rain = setup('sea', 'sea', { cycle: 3 });
    rain.state.weather = 'rain';
    await dealDamage(ctxOf(rain, 'P1'), {
      to: { kind: 'player', player: 'P2' },
      amount: 2,
      tags: [],
      flags: {},
      dealer: 'P1',
    });
    assert.equal(rain.state.players.P2.life, 30 - 2);
  });

  it('装甲は ignoreArmor で貫通される', async () => {
    const a = setup('sea', 'sea');
    a.state.players.P2.status.armor = 2;
    await dealDamage(ctxOf(a, 'P1'), {
      to: { kind: 'player', player: 'P2' },
      amount: 5,
      tags: [],
      flags: {},
      dealer: 'P1',
    });
    assert.equal(a.state.players.P2.life, 27);

    const b = setup('sea', 'sea');
    b.state.players.P2.status.armor = 2;
    await dealDamage(ctxOf(b, 'P1'), {
      to: { kind: 'player', player: 'P2' },
      amount: 5,
      tags: [],
      flags: { ignoreArmor: true },
      dealer: 'P1',
    });
    assert.equal(b.state.players.P2.life, 25);
  });
});

// ============================================================
// NamedAction（戦技）と神のパッシブ
// ============================================================

describe('NamedAction', () => {
  it('斬撃: 3点', async () => {
    const engine = setup('earth', 'sea');
    await resolveTop({ t: 'performAction', action: 'earth/slash' }, topCtx(engine, 'P1'));
    assert.equal(engine.state.players.P2.life, 27);
  });

  it('刺突: 1点を2回（合計2点。企画書「基本ルール」の 1+1）', async () => {
    const engine = setup('earth', 'sea');
    await resolveTop({ t: 'performAction', action: 'earth/thrust' }, topCtx(engine, 'P1'));
    assert.equal(engine.state.players.P2.life, 28);
  });

  it('刺突にもサイクルボーナスが乗る（2サイクル目なら 3+3）', async () => {
    // 企画書 大地の神設定「刺突は通常1点を2回 … サイクルダメージボーナスなどで伸びる」
    const engine = setup('earth', 'sea', { cycle: 2 });
    await resolveTop({ t: 'performAction', action: 'earth/thrust' }, topCtx(engine, 'P1'));
    assert.equal(engine.state.players.P2.life, 24);
  });

  it('打撃: 軽減されない', async () => {
    const engine = setup('earth', 'sea');
    engine.state.players.P2.status.reduction = 10;
    await resolveTop({ t: 'performAction', action: 'earth/strike' }, topCtx(engine, 'P1'));
    // 2点。軽減10 を無視して通る
    assert.equal(engine.state.players.P2.life, 28);
  });

  it('コンビネーション: 戦技を2回、同じものは選ばない', async () => {
    // 選択肢は 斬撃/刺突/打撃。1回目に斬撃、2回目は残りの先頭（刺突）
    const engine = setup('earth', 'sea', { chooser: [{ selectLabels: ['斬撃'] }] });
    await resolveTop(
      { t: 'performAction', times: 2, distinct: true, action: { t: 'chooseFrom', group: 'earth/combatArt' } },
      topCtx(engine, 'P1'),
    );
    // 斬撃4 + 刺突(1+1)*2=4 → 8
    // 斬撃3 + 刺突(1+1) = 5点
    assert.equal(engine.state.players.P2.life, 25);
  });

  it('攻撃指令: xは選んだ種族の体数。魔獣がいればダメージボーナスが乗る', async () => {
    const engine = setup('life', 'sea');
    engine.state.players.P1.minions = { human: 3 };
    // 種族の選択肢は人間のみ → 自動決定
    await resolveTop({ t: 'performAction', action: 'life/attackOrder' }, topCtx(engine, 'P1'));
    assert.equal(engine.state.players.P2.life, 27);

    const withBeast = setup('life', 'sea', { chooser: [{ selectLabels: ['人間'] }] });
    withBeast.state.players.P1.minions = { human: 3, beast: 2 };
    await resolveTop({ t: 'performAction', action: 'life/attackOrder' }, topCtx(withBeast, 'P1'));
    // 3（人間の数）+ 2（魔獣2体のダメージボーナス, tags:attackOrder）= 5
    assert.equal(withBeast.state.players.P2.life, 25);
  });
});

// ============================================================
// ミニオン
// ============================================================

describe('装備（トークン）の誘発', () => {
  it('「このカードが生成されたとき」は自分自身にだけ誘発する', async () => {
    // ヴァーミリオンピアス（槍）は生成されたときに刺突を行う。
    // 装備したあとに**別の装備**を作っても、槍は刺突しない
    const engine = setup('earth', 'sea');
    const ctx = topCtx(engine, 'P1');

    await resolveTop({ t: 'createToken', equip: true, token: 'earth/spear' }, ctx);
    await drainTriggers(engine);
    assert.equal(engine.state.players.P2.life, 28, '槍の生成で 1+1 の刺突');

    await resolveTop({ t: 'createToken', equip: true, token: 'earth/sword' }, ctx);
    await drainTriggers(engine);
    assert.equal(engine.state.players.P2.life, 28, '剣を作っただけでは刺突しない');

    await resolveTop({ t: 'createToken', equip: true, token: 'earth/spear' }, ctx);
    await drainTriggers(engine);
    assert.equal(engine.state.players.P2.life, 26, '2本目の槍を作れば、その槍が刺突する');
  });
});

describe('ミニオン', () => {
  it('死霊: 死亡した数だけ相手にダメージ。軽減されずサイクルボーナスも乗らない', async () => {
    const engine = setup('life', 'sea', { cycle: 5 });
    engine.state.players.P1.minions = { wraith: 2 };
    engine.state.players.P2.status.reduction = 10;

    await resolveTop({ t: 'sacrificeMinion', species: 'wraith', count: 2 }, topCtx(engine, 'P1'));

    // 2点ちょうど（軽減10 もサイクル+5 も効かない）
    assert.equal(engine.state.players.P2.life, 28);
    assert.equal(engine.state.players.P1.minions.wraith, 0);
  });

  it('天使: 超過ダメージをすべて吸収する（overflow: absorb）', async () => {
    const engine = setup('life', 'sea');
    engine.state.players.P1.minions = { angel: 2 };

    await dealDamage(ctxOf(engine, 'P2'), {
      to: { kind: 'player', player: 'P1' },
      amount: 7,
      tags: [],
      flags: {},
      dealer: 'P2',
    });

    // 天使2体が2点吸い、残り5点は absorb で消える
    assert.equal(engine.state.players.P1.life, 30);
    assert.equal(engine.state.players.P1.minions.angel, 0);
  });

  it('防御指令: ミニオンに優先的に割り振り、超過はプレイヤーに流れる（carry）', async () => {
    const engine = setup('life', 'sea');
    engine.state.players.P1.minions = { human: 2 };
    // 防御指令は「常在」なので、スタックに乗せた時点から働く
    await resolveTop(
      { t: 'addToStack', payload: { t: 'action', action: 'life/defenseOrder' } },
      topCtx(engine, 'P1'),
    );

    await dealDamage(ctxOf(engine, 'P2'), {
      to: { kind: 'player', player: 'P1' },
      amount: 5,
      tags: [],
      flags: {},
      dealer: 'P2',
    });

    assert.equal(engine.state.players.P1.minions.human, 0);
    assert.equal(engine.state.players.P1.life, 27);
  });
});

// ============================================================
// 常在の3分解（continuous / triggered）
// ============================================================

describe('常在', () => {
  it('アンプリファイバブルシールド: 詠唱カウンター分を軽減し、軽減した分だけカウンターを失う', async () => {
    const engine = setup('sea', 'sea');
    const [card] = putInHand(engine, 'P1', ['sea/amplifiable_shield']);
    const item = await play(engine, 'P1', card!);

    // 詠唱1（プレイ時）+ onPlay で5 = 6
    assert.equal(item.counters.chant, 6);

    await resolveTop(
      { t: 'damage', to: { t: 'player', who: { t: 'opponent' } }, amount: 4 },
      topCtx(engine, 'P2'),
    );

    assert.equal(engine.state.players.P1.life, 30, '4点は全部軽減される');
    assert.equal(item.counters.chant, 2, '軽減した4だけカウンターが減る');

    await resolveTop(
      { t: 'damage', to: { t: 'player', who: { t: 'opponent' } }, amount: 3 },
      topCtx(engine, 'P2'),
    );

    assert.equal(engine.state.players.P1.life, 29, '2軽減して1点通る');
    assert.equal(item.counters.chant, 0);
    // カウンターが0以下になったのでスタックから墓地へ（誘発）
    assert.equal(engine.state.stacks[0]!.items.length, 0);
    assert.equal(engine.state.players.P1.zones.graveyard[0]!.length, 1);
  });

  it('リアクティブアクアスフィア: 上に乗せられたら3点、ダメージを与えていたら解決時に1枚引く', async () => {
    const engine = setup('sea', 'sea');
    putOnDeck(engine, 'P1', ['sea/flooding_wisdom']);
    putOnDeck(engine, 'P2', ['sea/flooding_wisdom', 'sea/flooding_wisdom']);
    const [sphere] = putInHand(engine, 'P1', ['sea/reactive_aqua_sphere']);
    const [other] = putInHand(engine, 'P2', ['sea/flooding_wisdom']);

    await play(engine, 'P1', sphere!);
    await play(engine, 'P2', other!);

    assert.equal(engine.state.players.P2.life, 27, '上に乗せた相手に3点');

    // スタックを上から解決 → 相手のカード → アクアスフィア
    await resolvePhase(engine);

    assert.equal(engine.state.players.P1.zones.hand[0]!.length, 1, 'ダメージを与えていたので1枚引く');
  });

  it('氾濫する知恵: 以降のドローが常に+1枚になる', async () => {
    const engine = setup('sea', 'sea');
    putOnDeck(engine, 'P1', ['sea/future_choice', 'sea/future_choice', 'sea/future_choice', 'sea/future_choice']);
    const [c] = putInHand(engine, 'P1', ['sea/flooding_wisdom']);
    const item = await play(engine, 'P1', c!);
    await resolvePhase(engine);

    // 「カードを1枚引く」→ そのあとに置換を得るので、本体のドローは1枚のまま
    assert.equal(engine.state.players.P1.zones.hand[0]!.length, 1);

    await resolveTop({ t: 'draw', player: { t: 'self' }, count: 1 }, topCtx(engine, 'P1'));
    assert.equal(engine.state.players.P1.zones.hand[0]!.length, 3, '以降のドローは常に+1される');
    void item;
  });
});

// ============================================================
// 神のパッシブと誘発順
// ============================================================

describe('生成のログ', () => {
  // リプレイで「大地がどの装備を作ったか」「生命がどのミニオンを何体作ったか」を追えるように
  it('トークンは名前と装備の有無が出る', async () => {
    const engine = setup('earth', 'life');
    await resolveTop({ t: 'createToken', equip: true, token: 'earth/sword' }, topCtx(engine, 'P1'));

    const line = engine.log.map((l) => l.text).find((t) => t.includes('生成'));
    assert.equal(line, 'P1 が生成: インフェルノフューリー（剣）（装備）');
  });

  it('ミニオンは種族・体数・生成後の合計が出る', async () => {
    const engine = setup('life', 'earth');
    engine.state.players.P1.minions.wraith = 1;
    await resolveTop({ t: 'createMinion', species: 'wraith', count: 2 }, topCtx(engine, 'P1'));

    const line = engine.log.map((l) => l.text).find((t) => t.includes('生成'));
    assert.equal(line, 'P1 が生成: 死霊 2体（計 3体）');
  });

  it('生贄は残りの体数が出る', async () => {
    const engine = setup('life', 'earth');
    engine.state.players.P1.minions.human = 4;
    await resolveTop({ t: 'sacrificeMinion', species: 'human', count: 3 }, topCtx(engine, 'P1'));

    const line = engine.log.map((l) => l.text).find((t) => t.includes('生贄'));
    assert.equal(line, 'P1 が生贄: 人間 3体（残り 1体）');
  });
});

describe('死霊（ミニオンの種族特徴）', () => {
  /** P1 に死霊と人を並べてから、指定の種族を n 体殺す */
  async function kill(species: 'wraith' | 'human', n: number) {
    const engine = setup('life', 'sky');
    const p = engine.state.players.P1;
    p.minions.wraith = 3;
    p.minions.human = 3;
    const before = engine.state.players.P2.life;

    await resolveTop(
      { t: 'damage', to: { t: 'minion', species, owner: { t: 'self' } }, amount: n, flags: { ignoreCycleBonus: true } },
      topCtx(engine, 'P1'),
    );
    await drainTriggers(engine);
    return before - engine.state.players.P2.life;
  }

  it('死霊が死んだときだけ、死んだ死霊の数だけ飛ぶ', async () => {
    assert.equal(await kill('wraith', 2), 2, '死霊2体 → 2点');
  });

  it('他の種族が死んでも飛ばない', async () => {
    assert.equal(await kill('human', 3), 0, '人が死んでも死霊のダメージは出ない');
  });
});

describe('自傷ダメージ', () => {
  // 企画書「テストプレイ」の調整案①:
  // 「自傷は黒曜では軽減できないってやってみている。不壊くんあるしな。
  //   黒曜で防げると同じターンにブレイジング2枚以上がよりやりやすくなりすぎる。」
  it('ブレイジングラッシュの自傷は軽減されない', async () => {
    const engine = setup('earth', 'sky');
    engine.state.phase = 'stack';
    // 黒曜備え（装備数ぶん軽減）と、鎧袖一触が残す軽減の両方を積んでおく
    engine.state.players.P1.tokens.push({ uid: 'TK-a', defId: 'earth/armor_obsidian', owner: 'P1', equipped: true });
    engine.state.players.P1.status.reduction = 5;

    const [rush] = putInHand(engine, 'P1', ['earth/blazing_rush']);
    await play(engine, 'P1', rush!);
    const life = engine.state.players.P1.life;

    // 1枚プレイすると自傷が誘発する
    const [next] = putInHand(engine, 'P1', ['earth/crimson_ignition']);
    await play(engine, 'P1', next!);

    assert.equal(engine.state.players.P1.life, life - 2, '軽減6あっても2点そのまま通る');
  });

  it('不壊剛壁があれば無効化される（軽減不可でも無効化は効く）', async () => {
    const engine = setup('earth', 'sky');
    engine.state.phase = 'stack';

    const [wall] = putInHand(engine, 'P1', ['earth/indestructible_wall']);
    await play(engine, 'P1', wall!); // 常在なのでスタックに残って働く
    const [rush] = putInHand(engine, 'P1', ['earth/blazing_rush']);
    await play(engine, 'P1', rush!);
    const life = engine.state.players.P1.life;

    const [next] = putInHand(engine, 'P1', ['earth/crimson_ignition']);
    await play(engine, 'P1', next!);

    assert.equal(engine.state.players.P1.life, life, '不壊剛壁が自傷を無効化する');
  });

  it('燃え盛る大地の自傷も不壊剛壁で無効化される', async () => {
    const engine = setup('earth', 'sky');
    engine.state.phase = 'stack';

    const [wall] = putInHand(engine, 'P1', ['earth/indestructible_wall']);
    await play(engine, 'P1', wall!);
    const [burn] = putInHand(engine, 'P1', ['earth/burning_earth']);
    await play(engine, 'P1', burn!);
    const life = engine.state.players.P1.life;

    // 自分のカードを解決させると「解決しようとするたび1点」が誘発する
    const [card] = putInHand(engine, 'P1', ['earth/crimson_ignition']);
    const item = await play(engine, 'P1', card!);
    await resolveStackItem(topCtx(engine, 'P1'), item, false);
    await drainTriggers(engine);

    assert.equal(engine.state.players.P1.life, life, '不壊剛壁は燃え盛る大地も止める');
  });
});

describe('解決中の項目はスタックから出せない', () => {
  // 企画側判断（2026-09-06）。これが無いと「自分自身を手札に戻す → 手札が減らないまま
  // 打ち直す」が無限に回る（ループ・ザ・ループ / 熟達した跳躍）
  async function board(chooser?: ConstructorParameters<typeof ScriptedChooser>[0]) {
    const engine = setup('sky', 'earth', { ...(chooser ? { chooser } : {}) });
    engine.state.phase = 'stack';
    return engine;
  }

  it('ループ・ザ・ループは自分自身を手札に戻せない', async () => {
    const engine = await board();
    const [card] = putInHand(engine, 'P1', ['sky/loop_the_loop']);
    const life = engine.state.players.P1.life;

    await play(engine, 'P1', card!);

    assert.equal(
      engine.state.players.P1.zones.hand[0]!.some((c) => c.uid === card!.uid),
      false,
      '自分自身が手札に戻っている（無限ループの元）',
    );
    assert.equal(engine.state.players.P1.life, life, '戻せていないので回復も起きない');
  });

  it('熟達した跳躍も自分自身は戻せない', async () => {
    // モードは「スタック上のあなたのカードを1枚手札に戻す」を選ぶ
    const engine = await board([{ selectLabels: ['スタック上のあなたのカードを1枚手札に戻す。'] }]);
    const [card] = putInHand(engine, 'P1', ['sky/masterful_leap']);

    await play(engine, 'P1', card!);

    assert.equal(
      engine.state.players.P1.zones.hand[0]!.some((c) => c.uid === card!.uid),
      false,
      '自分自身が手札に戻っている',
    );
  });

  it('別のカードなら戻せる（機能は死んでいない）', async () => {
    const engine = await board();
    // 「あなたの手札に等しい枚数まで」戻すカードなので、手札が空だと0枚しか戻せない
    putInHand(engine, 'P1', ['sky/quick_change', 'sky/quick_change']);
    // 先に瞬発でないカードをスタックに置く
    const [first] = putInHand(engine, 'P1', ['sky/accelerate_gale']);
    const item = await play(engine, 'P1', first!);
    const life = engine.state.players.P1.life;

    const [loop] = putInHand(engine, 'P1', ['sky/loop_the_loop']);
    await play(engine, 'P1', loop!);

    assert.equal(
      engine.state.players.P1.zones.hand[0]!.some((c) => c.uid === item.card?.uid),
      true,
      '別のカードは手札に戻る',
    );
    assert.equal(engine.state.players.P1.life, life + 1, '戻した枚数だけ回復する');
  });
});

describe('サイクル開始', () => {
  it('生命の神はサイクル開始時に1種類を選んで2体得る', async () => {
    // 選択肢の先頭（人）を選ぶ AutoChooser で回す
    const engine = setup('life', 'earth');
    await startCycle(engine);

    assert.deepEqual(engine.state.players.P1.minions, { human: 2 }, '選んだ1種族だけ2体');

    // 2サイクル目は、パッシブの+2に加えて**人間自身の増殖**（自分の人の数だけ増える）が乗る
    await startCycle(engine);
    assert.deepEqual(engine.state.players.P1.minions, { human: 8 });
  });

  it('大地の神にパッシブは無い（④パッシブ能力案は未実装）', async () => {
    const engine = setup('earth', 'sea');
    await startCycle(engine);
    assert.equal(engine.state.players.P1.status.shield, 0, 'シールド5（難攻不落）は入れない');
  });

  it('シールドはターン終了時に0に戻る', async () => {
    const engine = setup('earth', 'sea');
    await startCycle(engine);
    await resolveTop(
      { t: 'gainStatus', player: { t: 'self' }, kind: 'shield', amount: 5, duration: 'thisTurn' },
      topCtx(engine, 'P1'),
    );
    assert.equal(engine.state.players.P1.status.shield, 5);
    await endTurn(engine);
    assert.equal(engine.state.players.P1.status.shield, 0);
  });
});

// ============================================================
// 束縛の3スケール
// ============================================================

describe('束縛', () => {
  it('snapshot は ability をまたいで残る（海の抱擁）', async () => {
    const engine = setup('sea', 'sea');
    const [c] = putInHand(engine, 'P1', ['sea/embrace']);
    const item = await play(engine, 'P1', c!);

    assert.deepEqual(item.snapshots.embraceLife, { of: 'number', value: 30 });

    // ライフが動かないまま解決 → 勝利
    await resolvePhase(engine);
    assert.equal(engine.state.winner, 'P1');
  });

  it('snapshot したライフと違えば勝利しない', async () => {
    const engine = setup('sea', 'sea');
    const [c] = putInHand(engine, 'P1', ['sea/embrace']);
    await play(engine, 'P1', c!);

    await resolveTop({ t: 'damage', to: { t: 'player', who: { t: 'opponent' } }, amount: 1 }, topCtx(engine, 'P2'));
    await resolvePhase(engine);
    assert.equal(engine.state.winner, undefined);
  });

  it('bind はダメージ量を数値として、ドローをカード集合として束縛する', async () => {
    const engine = setup('sea', 'sea');
    putOnDeck(engine, 'P1', ['sea/future_choice', 'sea/future_choice']);

    // 3点与え、その量だけ回復する
    await resolveTop(
      {
        t: 'bind',
        name: 'dmg',
        of: { t: 'damage', to: { t: 'player', who: { t: 'opponent' } }, amount: 3 },
        then: { t: 'heal', to: { t: 'self' }, amount: { t: 'var', name: 'dmg' } },
      },
      topCtx(engine, 'P1'),
    );
    assert.equal(engine.state.players.P2.life, 27);
    assert.equal(engine.state.players.P1.life, 33);
  });
});

// ============================================================
// 引き切りペナルティ
// ============================================================

describe('引き切りペナルティ', () => {
  it('引けなかった枚数分「30点のダメージを受ける」がスタックに積まれる', async () => {
    const engine = setup('sea', 'sea');
    putOnDeck(engine, 'P1', ['sea/future_choice']);

    await resolveTop({ t: 'draw', player: { t: 'self' }, count: 3 }, topCtx(engine, 'P1'));

    const items = engine.state.stacks[0]!.items;
    assert.equal(items.length, 2, '不足2枚 → 2つ積まれる');
    assert.equal(engine.state.players.P1.life, 30, 'まだ解決していないのでライフは減らない');

    await resolvePhase(engine);
    // 1つ目が解決した時点でライフ0 → 敗北が確定し、以降の解決は行われない
    assert.equal(engine.state.players.P1.life, 0);
    assert.equal(engine.state.winner, 'P2');
  });
});

// ============================================================
// countEvent.measure — 「回数」と「数量」を必ず区別する
// ============================================================

describe('countEvent.measure', () => {
  it('軽減しきったダメージは events では1、units では0', async () => {
    const engine = setup('sea', 'sea');
    engine.state.players.P2.status.reduction = 10;

    await dealDamage(ctxOf(engine, 'P1'), {
      to: { kind: 'player', player: 'P2' },
      amount: 3,
      tags: [],
      flags: {},
      dealer: 'P1',
    });
    assert.equal(engine.state.players.P2.life, 30);

    const ctx = topCtx(engine, 'P2');
    const asEvents = await evalValue(
      { t: 'countEvent', event: 'damageTaken', scope: 'cycle', measure: 'events', by: { t: 'self' } },
      ctx,
    );
    const asUnits = await evalValue(
      { t: 'countEvent', event: 'damageTaken', scope: 'cycle', measure: 'units', by: { t: 'self' } },
      ctx,
    );
    assert.equal(asEvents, 1, 'ダメージイベントは1回起きている');
    assert.equal(asUnits, 0, '通った量は0');
  });

  it('units は数量を合計する（2回のドローで枚数、複数体の死亡で体数）', async () => {
    const engine = setup('life', 'sea');
    putOnDeck(engine, 'P1', ['sea/future_choice', 'sea/future_choice', 'sea/future_choice']);
    const ctx = topCtx(engine, 'P1');

    await resolveTop({ t: 'draw', player: { t: 'self' }, count: 2 }, ctx);
    await resolveTop({ t: 'draw', player: { t: 'self' }, count: 1 }, ctx);

    assert.equal(
      await evalValue({ t: 'countEvent', event: 'drawn', scope: 'cycle', measure: 'events', by: { t: 'self' } }, ctx),
      2,
      'ドロー効果は2回',
    );
    assert.equal(
      await evalValue({ t: 'countEvent', event: 'drawn', scope: 'cycle', measure: 'units', by: { t: 'self' } }, ctx),
      3,
      '引いた枚数は3',
    );

    engine.state.players.P1.minions = { human: 3 };
    await resolveTop({ t: 'sacrificeMinion', species: 'human', count: 3 }, ctx);
    assert.equal(
      await evalValue({ t: 'countEvent', event: 'minionDied', scope: 'cycle', measure: 'events', by: { t: 'self' } }, ctx),
      1,
    );
    assert.equal(
      await evalValue({ t: 'countEvent', event: 'minionDied', scope: 'cycle', measure: 'units', by: { t: 'self' } }, ctx),
      3,
    );
  });

  it('犠牲の残り香: 死亡した死霊以外のミニオンの体数だけ死霊を生成する', async () => {
    const engine = setup('life', 'sea');
    engine.state.players.P1.minions = { human: 2, angel: 1, wraith: 4 };
    const ctx = topCtx(engine, 'P1');

    await resolveTop({ t: 'sacrificeMinion', species: 'human', count: 2 }, ctx);
    await resolveTop({ t: 'sacrificeMinion', species: 'angel', count: 1 }, ctx);
    await resolveTop({ t: 'sacrificeMinion', species: 'wraith', count: 4 }, ctx);

    const [c] = putInHand(engine, 'P1', ['life/echo_of_sacrifice']);
    await play(engine, 'P1', c!);
    await resolvePhase(engine);

    // 死霊以外は 人間2 + 天使1 = 3体（死霊4体は数えない）
    assert.equal(engine.state.players.P1.minions.wraith, 3);
  });
});

// ============================================================
// 未実装ノードは黙って無視せず例外にする
// ============================================================

describe('未実装の扱い', () => {
  it('登録されていない handler は NotImplementedError になる', async () => {
    const engine = createEngine({ pool: samplePool, p1God: 'creation', p2God: 'sea', chooser: new AutoChooser() });
    await assert.rejects(
      () => resolve({ t: 'handler', id: 'creation/unknown' }, topCtx(engine, 'P1')),
      /未実装/,
    );
  });
});
