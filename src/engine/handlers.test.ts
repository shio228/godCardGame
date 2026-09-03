/**
 * 標準 handler 3件（設計書 §7 の基準①「基礎構造を書き換える」に該当するカード）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { samplePool } from '../rules/cards.sample';
import { createEngine, play, putInHand, putOnDeck, resolvePhase } from './flow';
import type { Engine } from './context';
import type { God, PlayerId } from '../rules/types';

function setup(p1God: God): Engine {
  const engine = createEngine({ pool: samplePool, p1God, p2God: 'sky', seed: 5, budget: 20000 });
  engine.state.phase = 'stack';
  for (const pid of ['P1', 'P2'] as PlayerId[]) {
    putOnDeck(engine, pid, new Array(12).fill('sea/future_choice'));
  }
  return engine;
}

describe('並列思考（sea/splitDeck）', () => {
  it('デッキが2つの山に分かれ、以降どちらから引くか選べる', async () => {
    const engine = setup('sea');
    const [c] = putInHand(engine, 'P1', ['sea/parallel_thinking']);
    await play(engine, 'P1', c!);
    await resolvePhase(engine);

    const piles = engine.state.players.P1.zones.deck;
    assert.equal(piles.length, 2);
    assert.equal(piles[0]!.length + piles[1]!.length, 12);
    // P2 のデッキは分かれない
    assert.equal(engine.state.players.P2.zones.deck.length, 1);
  });
});

describe('スタック分割（creation/stackSplit）', () => {
  it('そのカードを先頭にした新しいスタックができる', async () => {
    const engine = setup('creation');
    const [c] = putInHand(engine, 'P1', ['creation/stack_split']);
    await play(engine, 'P1', c!);

    assert.equal(engine.state.stacks.length, 2);
    // resolveFirst:true なので先頭に置かれ、解決フェイズで最初に解決される
    assert.equal(engine.state.stacks[0]!.items.length, 1);
    assert.equal(engine.state.stacks[0]!.items[0]!.card?.uid, c!.uid);
    assert.equal(engine.state.stacks[0]!.items[0]!.stackId, engine.state.stacks[0]!.id);
  });

  it('解決フェイズは全てのスタックを空にし、1本に戻す', async () => {
    const engine = setup('creation');
    const [c] = putInHand(engine, 'P1', ['creation/stack_split']);
    await play(engine, 'P1', c!);
    await resolvePhase(engine);
    assert.equal(engine.state.stacks.length, 1);
    assert.equal(engine.state.stacks[0]!.items.length, 0);
  });
});

describe('ケイオス・フォーチュン（creation/mergeDecks）', () => {
  it('デッキが1つに統合され、両者が同じ山を共有する', async () => {
    const engine = setup('creation');
    const [c] = putInHand(engine, 'P1', ['creation/chaos_fortune']);
    await play(engine, 'P1', c!);
    await resolvePhase(engine);

    const d1 = engine.state.players.P1.zones.deck;
    const d2 = engine.state.players.P2.zones.deck;
    assert.equal(d1.length, 1);
    assert.equal(d2.length, 1);
    assert.equal(d1[0], d2[0]); // 同じ配列を指している = 共通デッキ
    assert.equal(d1[0]!.length, 24);
  });
});
