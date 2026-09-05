/**
 * 問い合わせの間隔の決め方。**費用に直結するのでここだけは単体で押さえる。**
 *
 * （`fetch` を使う部分はブラウザで実際に動かして確かめる。ここでは純粋な判断だけ。）
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isMyTurn, POLL_STEPS, pollDelay, SELF_TURN_MS, shouldPoll } from './net';
import type { PendingRequest, RoomSnapshot } from '../net/protocol';

const pending: PendingRequest = { index: 3, t: 'confirm', player: 'P1', prompt: 'やる？' };

function snapshot(over: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return { room: 'ABC123', version: 5, status: 'playing', seats: [], vsAi: false, ...over };
}

describe('ポーリングの判断', () => {
  it('タブが隠れているあいだは行かない', () => {
    assert.equal(shouldPoll(snapshot(), true), false);
    assert.equal(shouldPoll(snapshot(), false), true);
  });

  it('決着したら行かない', () => {
    assert.equal(shouldPoll(snapshot({ status: 'over' }), false), false);
  });

  it('相手を待つロビーでは行く', () => {
    assert.equal(shouldPoll(snapshot({ status: 'lobby' }), false), true);
  });

  it('自分の手番でも止めない（応答を取りこぼしたまま固まらないように）', () => {
    assert.equal(shouldPoll(snapshot({ pending }), false), true);
    assert.equal(isMyTurn(snapshot({ pending })), true);
    assert.equal(isMyTurn(snapshot()), false);
  });
});

describe('間隔', () => {
  it('相手を待つあいだはだんだん広がる', () => {
    const delays = [0, 1, 2, 3, 4, 5, 99].map((r) => pollDelay(r));
    assert.deepEqual(delays.slice(0, 5), POLL_STEPS);
    assert.equal(delays[5], POLL_STEPS[POLL_STEPS.length - 1], '最後の間隔で頭打ち');
    assert.equal(delays[6], POLL_STEPS[POLL_STEPS.length - 1]);
    for (let i = 1; i < delays.length; i++) assert.ok(delays[i]! >= delays[i - 1]!, '縮まない');
  });

  it('自分の手番のあいだは心音だけ（いちばん長い間隔より長い）', () => {
    assert.equal(pollDelay(0, true), SELF_TURN_MS);
    assert.ok(SELF_TURN_MS > Math.max(...POLL_STEPS));
  });
});
