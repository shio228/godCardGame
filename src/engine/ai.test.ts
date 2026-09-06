/**
 * 勝利条件の達成度（`progress.ts`）と目的志向AI（`ai.ts`）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { samplePool } from '../rules/cards.sample';
import { loadDeck } from '../rules/decks.load';
import { GreedyChooser } from './ai';
import { RandomChooser } from './chooser';
import { PLAY_PROMPT, createEngine, runGame, startGame } from './flow';
import { objectiveCtx, revealObjectiveById, setupObjectives } from './objectives';
import { conditionProgress, objectiveProgress, objectiveScore } from './progress';
import type { Engine } from './context';
import type { Condition, God } from '../rules/types';

function setup(p1God: God, p2God: God, objectives?: string[]): Engine {
  const engine = createEngine({ pool: samplePool, p1God, p2God, seed: 4, budget: 20000 });
  setupObjectives(engine, 'P1', objectives ?? loadDeck(p1God).objectives);
  setupObjectives(engine, 'P2', loadDeck(p2God).objectives);
  return engine;
}

// ============================================================
// 達成度
// ============================================================

describe('条件の達成度', () => {
  const ctxOf = (engine: Engine) => objectiveCtx(engine, 'P1');

  it('cmp >= は「あと何点で届くか」を比で返す', async () => {
    const engine = setup('life', 'sky');
    const cond: Condition = { t: 'cmp', a: { t: 'life', of: { t: 'self' } }, op: '>=', b: 99 };
    // 初期ライフ30 / 99
    assert.equal(Math.round(100 * (await conditionProgress(cond, ctxOf(engine)))!), 30);
    engine.state.players.P1.life = 99;
    assert.equal(await conditionProgress(cond, ctxOf(engine)), 1);
  });

  it('cmp == は差の小ささを見る', async () => {
    const engine = setup('sea', 'sky');
    const cond: Condition = { t: 'cmp', a: { t: 'life', of: { t: 'self' } }, op: '==', b: 35 };
    engine.state.players.P1.life = 35;
    assert.equal(await conditionProgress(cond, ctxOf(engine)), 1);
    engine.state.players.P1.life = 30;
    const p = (await conditionProgress(cond, ctxOf(engine)))!;
    assert.ok(p > 0.8 && p < 1, `p=${p}`);
  });

  it('and は「いくつ満たしたか」になる', async () => {
    const engine = setup('life', 'sky');
    const cond: Condition = {
      t: 'and',
      of: [
        { t: 'cmp', a: { t: 'countMinions', species: 'human', of: { t: 'self' } }, op: '>=', b: 5 },
        { t: 'cmp', a: { t: 'countMinions', species: 'angel', of: { t: 'self' } }, op: '>=', b: 5 },
      ],
    };
    engine.state.players.P1.minions = { human: 5, angel: 0 };
    assert.equal(await conditionProgress(cond, ctxOf(engine)), 0.5);
  });

  it('盤面から測れない条件は undefined（一撃必殺の amount）', async () => {
    const engine = setup('earth', 'sky');
    const cond: Condition = { t: 'cmp', a: { t: 'var', name: 'amount' }, op: '>=', b: 8 };
    assert.equal(await conditionProgress(cond, ctxOf(engine)), undefined);
  });
});

describe('勝利条件の達成度一覧', () => {
  it('自分の条件だけを、公開済みかどうかつきで返す', async () => {
    const engine = setup('earth', 'sky');
    const ps = await objectiveProgress(engine, 'P1');
    assert.equal(ps.length, 3);
    assert.ok(ps.every((p) => p.objective.god === 'earth'));
    assert.ok(ps.every((p) => p.revealed === false));
    // 一撃必殺は測れない、残り2つは測れる
    assert.equal(ps.filter((p) => p.progress === undefined).length, 1);
  });

  it('達成度の合計は、公開済みを重く見る', async () => {
    const engine = setup('life', 'sky');
    engine.state.players.P1.life = 99; // 生命の氾濫が成立
    const hidden = await objectiveScore(engine, 'P1', 0);
    const half = await objectiveScore(engine, 'P1', 0.5);
    assert.equal(hidden, 0, '伏せてある条件を0で見れば0');
    assert.ok(half > 0);
  });
});

// ============================================================
// 目的志向AI
// ============================================================

describe('目的志向AI', () => {
  async function run(chooserKind: 'greedy' | 'random', p1God: God, p2God: God, seed: number) {
    const chooser =
      chooserKind === 'greedy' ? new GreedyChooser({ fallback: new RandomChooser(seed) }) : new RandomChooser(seed);
    const engine = createEngine({ pool: samplePool, p1God, p2God, seed, budget: 30000, chooser });
    if (chooser instanceof GreedyChooser) chooser.attach(engine);
    await startGame(engine, { P1: loadDeck(p1God), P2: loadDeck(p2God) });
    const r = await runGame(engine);
    return { engine, r };
  }

  it('最後まで試合を回せる', async () => {
    const { r } = await run('greedy', 'earth', 'sky', 21);
    assert.ok(r.winner === 'P1' || r.winner === 'P2');
  });

  it('達成に近い勝利条件を先に公開する', async () => {
    // 生命の3条件のうち「生命の氾濫（ライフ99以上）」だけを成立寸前にしておく
    const chooser = new GreedyChooser();
    const engine = createEngine({ pool: samplePool, p1God: 'life', p2God: 'sky', seed: 8, budget: 20000, chooser });
    chooser.attach(engine);
    await startGame(engine, { P1: loadDeck('life'), P2: loadDeck('sky') });
    engine.state.players.P1.life = 98;

    const { startCycle } = await import('./flow');
    await startCycle(engine);
    assert.deepEqual(engine.state.players.P1.revealedObjectives, ['life/obj_life_99']);
  });

  it('ランダムより特殊勝利で決着しやすい', async () => {
    let greedyObjective = 0;
    let randomObjective = 0;
    for (let i = 0; i < 12; i++) {
      const g = await run('greedy', 'sea', 'sky', 100 + i);
      const r = await run('random', 'sea', 'sky', 100 + i);
      if (g.engine.state.winReason?.startsWith('勝利条件')) greedyObjective++;
      if (r.engine.state.winReason?.startsWith('勝利条件')) randomObjective++;
    }
    assert.ok(
      greedyObjective >= randomObjective,
      `目的志向 ${greedyObjective} / ランダム ${randomObjective}`,
    );
  });

  it('打てば得になる場面でパスしない', async () => {
    // 相手のライフを2にして、3点飛ぶカードを持たせる。パスより明確に良いので必ず打つ
    const chooser = new GreedyChooser({ fallback: new RandomChooser(1) });
    const engine = createEngine({ pool: samplePool, p1God: 'earth', p2God: 'sky', seed: 3, budget: 30000, chooser });
    chooser.attach(engine);
    await startGame(engine, { P1: loadDeck('earth'), P2: loadDeck('sky') });
    engine.state.phase = 'stack';
    engine.state.players.P2.life = 2;

    const { playChoices, putInHand } = await import('./flow');
    putInHand(engine, 'P1', ['earth/crimson_ignition']);
    const options = (await playChoices(engine, 'P1')).map((c) => ({ value: c, label: c.label }));
    const picked = await chooser.select({
      kind: 'card',
      player: 'P1',
      prompt: PLAY_PROMPT,
      options,
      min: 0,
      max: 1,
    });
    assert.equal(picked.length, 1, 'パスしてしまった');
    assert.equal(picked[0]!.label, '紅蓮着火');
  });

  it('スタックに載った時点の価値を見る（詠唱をあと1つ足せば勝ち）', async () => {
    // 「打った1枚だけを即解決して測る」作りだと、スタック上でしか成立しない条件
    //（詠唱の極致＝スタックの詠唱30）が見えず、勝ちに直結する手を見送っていた
    const chooser = new GreedyChooser({ fallback: new RandomChooser(1) });
    const engine = createEngine({ pool: samplePool, p1God: 'sea', p2God: 'sky', seed: 4, budget: 30000, chooser });
    chooser.attach(engine);
    await startGame(engine, { P1: loadDeck('sea'), P2: loadDeck('sky') });
    revealObjectiveById(engine, 'P1', 'sea/obj_chant_thirty');
    engine.state.phase = 'stack';

    // すでにスタックに詠唱29。もう1枚積めば30で勝ち
    const { play, playChoices, putInHand } = await import('./flow');
    const [seed1] = putInHand(engine, 'P1', ['sea/domain_expansion']);
    const item = await play(engine, 'P1', seed1!);
    item.counters.chant = 29;

    putInHand(engine, 'P1', ['sea/domain_expansion']);
    const options = (await playChoices(engine, 'P1')).map((c) => ({ value: c, label: c.label }));
    const picked = await chooser.select({ kind: 'card', player: 'P1', prompt: PLAY_PROMPT, options, min: 0, max: 1 });

    assert.equal(picked.length, 1, '勝ちに届く手を打たずにパスした');
    assert.equal(picked[0]!.label, 'ドメインエキスパンション');
  });

  it('スタックで働くカードは、置くだけでも選ぶ（置き点）', async () => {
    // ドレッドフル・タイダルウェイブは詠唱1で置くだけなら0点。
    // あとから蓄積の魔水で押し上げて初めて効くので、置き点が無いと選ばれない
    async function pick(onStackWeight: number): Promise<number> {
      const chooser = new GreedyChooser({ fallback: new RandomChooser(1), onStackWeight });
      const engine = createEngine({ pool: samplePool, p1God: 'sea', p2God: 'sky', seed: 6, budget: 30000, chooser });
      chooser.attach(engine);
      await startGame(engine, { P1: loadDeck('sea'), P2: loadDeck('sky') });
      engine.state.phase = 'stack';

      const { playChoices, putInHand } = await import('./flow');
      putInHand(engine, 'P1', ['sea/dreadful_tidal_wave']);
      const options = (await playChoices(engine, 'P1'))
        .filter((c) => c.label.includes('ドレッドフル'))
        .map((c) => ({ value: c, label: c.label }));
      const picked = await chooser.select({ kind: 'card', player: 'P1', prompt: PLAY_PROMPT, options, min: 0, max: 1 });
      return picked.length;
    }

    assert.equal(await pick(0), 0, '置き点が無ければ（0点なので）パスする');
    assert.equal(await pick(1), 1, '置き点があれば置く');
  });

  it('試し打ちは本番の盤面を汚さない', async () => {
    const chooser = new GreedyChooser();
    const engine = createEngine({ pool: samplePool, p1God: 'earth', p2God: 'sky', seed: 3, budget: 20000, chooser });
    chooser.attach(engine);
    await startGame(engine, { P1: loadDeck('earth'), P2: loadDeck('sky') });

    engine.state.phase = 'stack';
    const before = JSON.stringify(engine.state);
    const { playChoices } = await import('./flow');
    await chooser.select({
      kind: 'card',
      player: 'P1',
      prompt: 'プレイするカードを選ぶ（選ばなければパス）',
      options: (await playChoices(engine, 'P1')).map((c) => ({ value: c, label: c.label })),
      min: 0,
      max: 1,
    });
    assert.equal(JSON.stringify(engine.state), before, '選ぶだけで盤面が変わってはいけない');
  });
});
