/**
 * ターン進行のゴールデンテスト。
 * 企画書「基本ルール」のフェイズ定義・ドロー枚数・パスの規則をそのまま検証する。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { samplePool } from '../rules/cards.sample';
import { loadDeck } from '../rules/decks.load';
import { AutoChooser, type SelectRequest } from './chooser';
import { RuleError } from './errors';
import { resolve } from './effects';
import {
  DECK_MIN,
  PLAY_PROMPT,
  createEngine,
  drawPhase,
  endTurn,
  handLimitFor,
  endCycle,
  orderPhase,
  performAlternativePlay,
  play,
  playBlockReason,
  playChoices,
  putInHand,
  putOnDeck,
  runGame,
  stackPhase,
  startCycle,
  startGame,
  surrender,
  topCtx,
  validateDeck,
} from './flow';
import type { Engine } from './context';
import type { Effect, God, PlayerId } from '../rules/types';

/** 常にパスする手なり。ドロー枚数・フェイズ進行だけを見たいとき用 */
class PassChooser extends AutoChooser {
  override async select<T>(req: SelectRequest<T>): Promise<T[]> {
    if (req.prompt === PLAY_PROMPT) return [];
    return super.select(req);
  }
}

/** 指定した枚数だけプレイしてからパスする */
class PlayNChooser extends AutoChooser {
  private left: number;
  constructor(n: number) {
    super();
    this.left = n;
  }
  override async select<T>(req: SelectRequest<T>): Promise<T[]> {
    if (req.prompt === PLAY_PROMPT) {
      if (this.left <= 0) return [];
      this.left--;
      return req.options.slice(0, 1).map((o) => o.value);
    }
    return super.select(req);
  }
}

function engineOf(chooser?: AutoChooser): Engine {
  return createEngine({
    pool: samplePool,
    p1God: 'sea',
    p2God: 'earth',
    seed: 20260902,
    budget: 30000,
    ...(chooser ? { chooser } : {}),
  });
}

/** 神を指定して開始まで済ませる */
async function startWith(g1: God, g2: God, chooser: AutoChooser, seed = 20260902): Promise<Engine> {
  const engine = createEngine({ pool: samplePool, p1God: g1, p2God: g2, seed, budget: 30000, chooser });
  await startGame(engine, { P1: loadDeck(g1), P2: loadDeck(g2) });
  return engine;
}

function hand(engine: Engine, pid: PlayerId): number {
  return engine.state.players[pid].zones.hand[0]!.length;
}

function deck(engine: Engine, pid: PlayerId): number {
  return engine.state.players[pid].zones.deck[0]!.length;
}

/**
 * ゲームを始めて**0サイクル目のドローまで**進める。
 * 企画書のドロー表では初期手札7枚が「0サイクル目のドロー」なので、
 * 「始まった直後」はここまで含む（`startGame` 自体は配らない）。
 */
async function startSample(engine: Engine): Promise<void> {
  await startGame(engine, { P1: loadDeck('sea'), P2: loadDeck('earth') });
  await startCycle(engine);
  await drawPhase(engine);
}

// ============================================================
// 1-1. ゲーム開始
// ============================================================

describe('startGame', () => {
  it('0サイクル目のドローで7枚配られる（初期手札）', async () => {
    const engine = engineOf(new PassChooser());
    await startGame(engine, { P1: loadDeck('sea'), P2: loadDeck('earth') });

    // 配るのは 0 サイクル目のドローフェイズ。`startGame` の時点では手札は空
    assert.equal(hand(engine, 'P1'), 0, 'startGame は配らない');
    // 勝利条件は伏せた状態で3つ（公開はサイクル開始フェイズで起きる）
    assert.equal(engine.state.players.P1.objectives.length, 3);
    assert.equal(engine.state.players.P1.revealedObjectives.length, 0);

    await startCycle(engine);
    await drawPhase(engine);

    assert.equal(hand(engine, 'P1'), 7);
    assert.equal(hand(engine, 'P2'), 7);
    assert.equal(deck(engine, 'P1'), DECK_MIN - 7);
    assert.equal(engine.state.cycle, 0, '最初のサイクルは0サイクル目');
    assert.equal(engine.state.players.P1.revealedObjectives.length, 1, '0サイクル目にも1つ公開する');
  });

  it('最初のプレイは0サイクル目・手札7枚（1サイクル目に飛ばさない）', async () => {
    // 企画書「基本ルール」: 初期手札7枚＝0サイクル目のドロー。
    // 0サイクル目を丸ごと飛ばすと、最初のプレイが手札12枚（7+5）になってしまう
    const seen: { cycle: number; hand: number }[] = [];
    class WatchChooser extends AutoChooser {
      override async select<T>(req: SelectRequest<T>): Promise<T[]> {
        if (req.prompt === PLAY_PROMPT) {
          seen.push({ cycle: engine.state.cycle, hand: hand(engine, req.player) });
          return [];
        }
        return super.select(req);
      }
    }
    const engine = engineOf(new WatchChooser());
    await startGame(engine, { P1: loadDeck('sea'), P2: loadDeck('earth') });
    await startCycle(engine);
    await drawPhase(engine);
    await stackPhase(engine);

    assert.deepEqual(seen[0], { cycle: 0, hand: 7 }, `最初の選択が ${JSON.stringify(seen[0])} になっている`);
  });

  it('終末は2サイクル目の終了フェイズに加わる', async () => {
    const engine = engineOf(new PassChooser());
    await startGame(engine, { P1: loadDeck('sea'), P2: loadDeck('earth') });

    for (const expected of [false, false, true]) {
      await startCycle(engine);
      await endCycle(engine);
      assert.equal(
        engine.state.apocalypse,
        expected,
        `${engine.state.cycle} サイクル目の終了時に apocalypse=${engine.state.apocalypse}`,
      );
    }
    assert.equal(engine.state.cycle, 2, '0 → 1 → 2 と数える');
  });

  it('シャッフルされている（デッキ順が構築順と違う）', async () => {
    const engine = engineOf(new PassChooser());
    const list = loadDeck('sea');
    await startSample(engine);
    const ids = engine.state.players.P1.zones.deck[0]!.map((c) => c.defId);
    assert.notDeepEqual(ids, list.cards.slice(0, ids.length));
  });

  it('デッキ枚数・同名上限・神の不一致を弾く', () => {
    const engine = engineOf();
    const sea = loadDeck('sea').cards;
    assert.throws(() => validateDeck(engine, 'P1', sea.slice(0, 29)), RuleError);
    assert.throws(() => validateDeck(engine, 'P1', [...sea, ...sea.slice(0, 11)]), RuleError);
    assert.throws(() => validateDeck(engine, 'P1', new Array(30).fill(sea[0]!)), RuleError);
    // P1 は海。大地のカードは入らない
    assert.throws(() => validateDeck(engine, 'P1', loadDeck('earth').cards), RuleError);
    assert.doesNotThrow(() => validateDeck(engine, 'P1', sea));
  });
});

// ============================================================
// 1-2. ドローフェイズ
// ============================================================

describe('ドローフェイズ', () => {
  it('サイクル別のドロー枚数（累計 7 / 12 / 18）', async () => {
    const engine = engineOf(new PassChooser());
    await startSample(engine);
    assert.equal(deck(engine, 'P1'), 23);

    await startCycle(engine);
    await drawPhase(engine);
    assert.equal(deck(engine, 'P1'), 18); // 1サイクル目 5枚

    await startCycle(engine);
    await drawPhase(engine);
    assert.equal(deck(engine, 'P1'), 12); // 2サイクル目 6枚
  });

  it('引き切ると「30点のダメージを受ける」がスタックに積まれる', async () => {
    const engine = engineOf(new PassChooser());
    await startSample(engine);
    // デッキを空にしてからドローさせる
    engine.state.players.P1.zones.deck[0]!.length = 0;
    engine.state.players.P2.zones.deck[0]!.length = 0;

    await startCycle(engine);
    await drawPhase(engine);

    // 先攻5枚 + 後攻5枚 = 10個
    assert.equal(engine.state.stacks[0]!.items.length, 10);
  });
});

// ============================================================
// 1-3. スタックフェイズ
// ============================================================

describe('スタックフェイズ', () => {
  it('両者パスで終わる（何も乗らない）', async () => {
    const engine = engineOf(new PassChooser());
    await startSample(engine);
    await startCycle(engine);
    await drawPhase(engine);
    await stackPhase(engine);
    assert.equal(engine.state.stacks[0]!.items.length, 0);
  });

  it('手札が0枚なら強制パス', async () => {
    const engine = engineOf(new AutoChooser());
    await startSample(engine);
    engine.state.players.P1.zones.hand[0]!.length = 0;
    engine.state.players.P2.zones.hand[0]!.length = 0;
    engine.state.phase = 'stack';
    await stackPhase(engine);
    assert.equal(engine.state.stacks[0]!.items.length, 0);
  });

  it('一度パスしたプレイヤーはそのフェイズ中プレイできない', async () => {
    // P1 は1枚だけプレイしてパス。P2 は AutoChooser なので手札を出し切る
    const engine = createEngine({
      pool: samplePool,
      p1God: 'sea',
      p2God: 'earth',
      seed: 3,
      budget: 30000,
      chooser: new PlayNChooser(1),
    });
    await startGame(engine, { P1: loadDeck('sea'), P2: loadDeck('earth') });
    await startCycle(engine);
    await drawPhase(engine);
    const first = engine.state.first;
    await stackPhase(engine);

    // PlayNChooser は両者で共有されるので「合計1枚だけプレイされた」ことを見る。
    // 1枚出した先攻はそこでパス扱いになり、以降プレイできない。
    // 手札の増減は見ない — 瞬発のドローカードだとプレイしても手札が減らないことがある
    const played = engine.state.events.filter((e) => e.kind === 'played');
    assert.equal(played.length, 1);
    assert.equal(played[0]!.player, first);
  });
});

// ============================================================
// 1-4 / 1-5. 順番確定フェイズと瞬発
// ============================================================

describe('瞬発と順番確定フェイズ', () => {
  it('瞬発はプレイしたその場で解決してスタックから降りる', async () => {
    const engine = engineOf();
    engine.state.phase = 'stack';
    const [c] = putInHand(engine, 'P1', ['sky/quick_change']);
    const item = await play(engine, 'P1', c!);

    assert.equal(engine.state.stacks[0]!.items.length, 0);
    assert.equal(engine.state.players.P1.zones.graveyard[0]!.some((x) => x.uid === c!.uid), true);
    assert.equal(engine.state.events.some((e) => e.kind === 'resolved' && e.itemUid === item.uid), true);
  });

  it('瞬発はスタックフェイズにしかプレイできない', async () => {
    const engine = engineOf();
    engine.state.phase = 'order';
    const [c] = putInHand(engine, 'P1', ['sky/quick_change']);
    assert.match((await playBlockReason(engine, 'P1', c!)) ?? '', /フェイズ/);
    await assert.rejects(() => play(engine, 'P1', c!), RuleError);
  });

  it('順番確定フェイズには timing:orderPhase のカードだけが出せる', async () => {
    const engine = engineOf(new PassChooser());
    await startSample(engine);
    const [trick] = putInHand(engine, 'P1', ['earth/ambush']);
    const [other] = putInHand(engine, 'P1', ['sea/future_choice']);
    engine.state.phase = 'order';

    assert.equal(await playBlockReason(engine, 'P1', trick!), undefined);
    assert.match((await playBlockReason(engine, 'P1', other!)) ?? '', /フェイズ/);
  });

  it('順番確定フェイズは orderPhaseStart を出す', async () => {
    const engine = engineOf(new PassChooser());
    await startSample(engine);
    await orderPhase(engine);
    assert.equal(engine.state.events.some((e) => e.kind === 'orderPhaseStart'), true);
  });
});

// ============================================================
// 1-6. 降伏
// ============================================================

describe('降伏', () => {
  it('降伏したら相手の勝ち', async () => {
    const engine = engineOf();
    surrender(engine, 'P1');
    assert.equal(engine.state.winner, 'P2');
  });
});

// ============================================================
// 優先度4: handLimit / alternativePlay / grantKeyword
// ============================================================

describe('手札上限', () => {
  it('終了フェイズに10枚まで捨てる', async () => {
    const engine = engineOf(new PassChooser());
    await startSample(engine);
    putInHand(engine, 'P1', new Array(6).fill('sea/future_choice'));
    assert.equal(hand(engine, 'P1'), 13);
    await endTurn(engine);
    assert.equal(hand(engine, 'P1'), 10);
    assert.equal(await handLimitFor(engine, 'P1'), 10);
  });

  it('handLimit:none なら何枚でも持ち越せる（叡智保管庫）', async () => {
    const engine = engineOf(new PassChooser());
    await startSample(engine);
    putInHand(engine, 'P1', new Array(6).fill('sea/future_choice'));
    await resolve(
      {
        t: 'grantContinuous',
        duration: 'thisGame',
        mod: { t: 'handLimit', amount: 'none', who: { t: 'self' } },
      },
      topCtx(engine, 'P1'),
    );
    await endTurn(engine);
    assert.equal(hand(engine, 'P1'), 13);
  });
});

describe('代替プレイ（クルーエルカーネイジ）', () => {
  const grantAlt: Effect = {
    t: 'grantContinuous',
    duration: 'thisCycle',
    mod: {
      t: 'alternativePlay',
      who: { t: 'self' },
      cost: { t: 'discard', player: { t: 'self' }, count: 1 },
      play: { t: 'action', action: 'earth/slash' },
    },
  };

  it('手札1枚を捨てて戦技をスタックに乗せられる', async () => {
    const engine = createEngine({ pool: samplePool, p1God: 'earth', p2God: 'sky', seed: 9, budget: 20000 });
    engine.state.phase = 'stack';
    putInHand(engine, 'P1', ['earth/blazing_rush', 'earth/blazing_rush']);
    await resolve(grantAlt, topCtx(engine, 'P1'));

    const choices = await playChoices(engine, 'P1');
    const alt = choices.find((c) => c.kind === 'alternative');
    assert.ok(alt, '代替プレイが選択肢に並ぶ');
    if (alt?.kind !== 'alternative') return;

    await performAlternativePlay(engine, 'P1', alt.mod);
    assert.equal(hand(engine, 'P1'), 1);
    assert.equal(engine.state.stacks[0]!.items.length, 1);
    assert.equal(engine.state.stacks[0]!.items[0]!.kind, 'action');
  });

  it('コストを払えないなら選択肢に出ない（手札0枚）', async () => {
    const engine = createEngine({ pool: samplePool, p1God: 'earth', p2God: 'sky', seed: 9, budget: 20000 });
    engine.state.phase = 'stack';
    await resolve(grantAlt, topCtx(engine, 'P1'));
    const choices = await playChoices(engine, 'P1');
    assert.equal(choices.length, 0);
  });
});

describe('付与された瞬発（スカイエンハンス）', () => {
  it('手札を1枚捨てて瞬発としてプレイできる', async () => {
    const engine = createEngine({ pool: samplePool, p1God: 'sky', p2God: 'earth', seed: 11, budget: 20000 });
    engine.state.phase = 'stack';
    putOnDeck(engine, 'P1', new Array(6).fill('sky/quick_change'));
    putInHand(engine, 'P1', ['sky/quick_change']); // 捨てる用
    const [c] = putInHand(engine, 'P1', ['sky/sky_enhance']);

    const item = await play(engine, 'P1', c!);
    // 瞬発扱いなので即解決してスタックから降りている
    assert.equal(engine.state.stacks[0]!.items.some((x) => x.uid === item.uid), false);
    // コストで手札を1枚捨てている
    assert.equal(engine.state.players.P1.zones.graveyard[0]!.length >= 1, true);
  });
});

// ============================================================
// 1試合通し
// ============================================================

describe('runGame', () => {
  it('手なり同士で最後まで進み、勝敗がつく', async () => {
    // 海と創造は未登録 handler のカード（並列思考・スタック分割）を持つので、
    // 通しで回せるのは大地・空・生命
    const engine = await startWith('earth', 'sky', new AutoChooser());
    const r = await runGame(engine);
    assert.ok(r.winner === 'P1' || r.winner === 'P2', `winner=${r.winner}`);
    // サイクルは0起点。30枚デッキなら4サイクル目で引き切るので、それより長引かない
    assert.ok(r.cycles >= 0 && r.cycles <= 6, `cycles=${r.cycles}`);
  });

  it('誰もカードをプレイしなくても引き切りペナルティで決着する（4サイクル決着の強制終了）', async () => {
    const engine = engineOf(new PassChooser());
    await startSample(engine);
    const r = await runGame(engine);
    assert.ok(r.winner !== 'draw');
    // 30枚デッキは4サイクル目で尽きるので、そこから先は長引かない
    assert.ok(r.cycles <= 6, `cycles=${r.cycles}`);
  });
});
