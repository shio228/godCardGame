/**
 * 人が打つ Chooser の入力解釈。
 * 標準入力は使わず、`ask` を差し替えて台本どおりに答えさせる。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { samplePool } from '../src/rules/cards.sample';
import { createEngine } from '../src/engine/flow';
import type { Engine } from '../src/engine/context';
import { HumanChooser, renderBoard } from './human';

/** 台本どおりに答える入力。尽きたら例外（無限ループの検出） */
function scripted(lines: string[]): { ask: (p: string) => Promise<string>; left: () => number } {
  let i = 0;
  return {
    ask: async () => {
      if (i >= lines.length) throw new Error('入力が尽きた（聞かれすぎ）');
      return lines[i++]!;
    },
    left: () => lines.length - i,
  };
}

function setup(lines: string[]): { chooser: HumanChooser; engine: Engine; out: string[]; left: () => number } {
  const out: string[] = [];
  const s = scripted(lines);
  const chooser = new HumanChooser({ ask: s.ask, write: (t) => out.push(t) });
  const engine = createEngine({ pool: samplePool, p1God: 'earth', p2God: 'sky', seed: 1 });
  chooser.attach(engine);
  return { chooser, engine, out, left: s.left };
}

const options = ['紅蓮着火', '鎧袖一触', 'コンビネーション'].map((label, i) => ({ value: i, label }));

const req = (min: number, max: number) =>
  ({ kind: 'card' as const, player: 'P1' as const, prompt: 'プレイするカードを選ぶ', options, min, max });

describe('人の選択', () => {
  it('番号で選ぶ', async () => {
    const { chooser } = setup(['2']);
    assert.deepEqual(await chooser.select(req(1, 1)), [1]);
  });

  it('空Enterは「選ばない」（min:0のとき）', async () => {
    const { chooser } = setup(['']);
    assert.deepEqual(await chooser.select(req(0, 1)), []);
  });

  it('選択が必須なら空Enterを拒んで聞き直す', async () => {
    const { chooser, out } = setup(['', '1']);
    assert.deepEqual(await chooser.select(req(1, 1)), [0]);
    assert.ok(out.some((t) => t.includes('選ばないことはできません')));
  });

  it('カンマ区切りで複数選ぶ', async () => {
    const { chooser } = setup(['1,3']);
    assert.deepEqual(await chooser.select(req(2, 2)), [0, 2]);
  });

  it('範囲外・重複・件数違いは聞き直す', async () => {
    const { chooser, out } = setup(['9', '1,1', '1', '1,2']);
    assert.deepEqual(await chooser.select(req(2, 2)), [0, 1]);
    assert.ok(out.some((t) => t.includes('範囲外')));
    assert.ok(out.some((t) => t.includes('同じ番号')));
  });

  it('? はヘルプを出して聞き直す', async () => {
    const { chooser, out } = setup(['?', '1']);
    await chooser.select(req(1, 1));
    assert.ok(out.some((t) => t.includes('投了する')));
  });

  it('b は盤面を出して聞き直す', async () => {
    const { chooser, out } = setup(['b', '1']);
    await chooser.select(req(1, 1));
    assert.ok(out.filter((t) => t.includes('サイクル')).length >= 2);
  });

  it('q は投了して相手の勝ちになる', async () => {
    const { chooser, engine } = setup(['q']);
    await chooser.select(req(1, 1));
    assert.equal(engine.state.winner, 'P2');
    assert.equal(engine.state.winReason, '降伏');
  });
});

describe('人の入力（数値・確認・並べ替え）', () => {
  it('number は範囲を守らせる', async () => {
    const { chooser, out } = setup(['99', '3']);
    assert.equal(await chooser.number({ player: 'P1', prompt: '数を選ぶ', min: 0, max: 5 }), 3);
    assert.ok(out.some((t) => t.includes('整数')));
  });

  it('number の空Enterは最小値', async () => {
    const { chooser } = setup(['']);
    assert.equal(await chooser.number({ player: 'P1', prompt: '数を選ぶ', min: 2, max: 5 }), 2);
  });

  it('confirm は y / n', async () => {
    const { chooser } = setup(['y']);
    assert.equal(await chooser.confirm({ player: 'P1', prompt: '使う？' }), true);
    const no = setup(['n']);
    assert.equal(await no.chooser.confirm({ player: 'P1', prompt: '使う？' }), false);
  });

  it('confirm は答えになっていなければ聞き直す', async () => {
    const { chooser, out } = setup(['たぶん', 'n']);
    assert.equal(await chooser.confirm({ player: 'P1', prompt: '使う？' }), false);
    assert.ok(out.some((t) => t.includes('y か n')));
  });

  it('order は空Enterでそのまま、番号列で並べ替える', async () => {
    const { chooser } = setup(['']);
    const r = { kind: 'stack' as const, player: 'P1' as const, prompt: '順番', options };
    assert.deepEqual(await chooser.order(r), [0, 1, 2]);

    const swapped = setup(['3,1,2']);
    assert.deepEqual(await swapped.chooser.order(r), [2, 0, 1]);
  });

  it('order は全部を1回ずつ並べないと聞き直す', async () => {
    const { chooser, out } = setup(['1,2', '1,2,3']);
    await chooser.order({ kind: 'stack', player: 'P1', prompt: '順番', options });
    assert.ok(out.some((t) => t.includes('1回ずつ')));
  });
});

describe('盤面表示', () => {
  it('サイクル・天候・両者のライフが出る', () => {
    const { engine } = setup([]);
    const text = renderBoard(engine, 'P1', { P1: '大地アグロ', P2: '空天候' });
    assert.match(text, /サイクル/);
    assert.match(text, /天候 calm/);
    assert.match(text, /大地アグロ/);
    assert.match(text, /空天候/);
    assert.match(text, /ライフ\s+30/);
  });
});
