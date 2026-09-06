/**
 * 部屋のロジック。**ソケットもHTTPも無しで**1試合を最後まで通す。
 *
 * 遠隔対戦の要は「選択の列だけを保存し、必要なときだけ再生する」ことなので、
 * ここが通れば通信の層は薄い受け渡しに過ぎない。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { samplePool } from '../rules/cards.sample';
import { DECK_TEXTS } from '../rules/decks.generated';
import { RoomService } from './room';
import { MemoryStore } from './store';
import type { PendingRequest, RoomSnapshot } from './protocol';
import type { PlayerId } from '../rules/types';

function service(): { svc: RoomService; store: MemoryStore } {
  const store = new MemoryStore();
  return { svc: new RoomService({ pool: samplePool, store, aiSeed: 7 }), store };
}

/** 先頭の選択肢を選ぶ（`min` を満たす最小の選び方） */
function firstAnswer(p: PendingRequest): number[] | number | boolean {
  if (p.t === 'confirm') return true;
  if (p.t === 'number') return p.min ?? 0;
  const options = p.options ?? [];
  if (p.t === 'order') return options.map((_, i) => i);
  const n = Math.min(Math.max(p.min ?? 0, 1), Math.min(p.max ?? 1, options.length));
  return options.slice(0, n).map((_, i) => i);
}

interface Seated {
  seat: PlayerId;
  token: string;
}

async function openRoom(
  svc: RoomService,
  opts: { vsAi?: boolean } = {},
): Promise<{ room: string; p1: Seated; p2?: Seated; snap: RoomSnapshot }> {
  const created = await svc.handle({
    t: 'create',
    name: 'あなた',
    deck: { preset: 'earth' },
    seed: 12345,
    ...(opts.vsAi ? { vsAi: true } : {}),
  });
  const p1 = created.you!;
  if (opts.vsAi) return { room: created.room, p1, snap: created };

  const joined = await svc.handle({ t: 'join', room: created.room, name: 'あいて' });
  const p2 = joined.you!;
  await svc.handle({ t: 'deck', room: created.room, ...p2, deck: { preset: 'sky' } });
  const snap = await svc.handle({ t: 'ready', room: created.room, ...p2, ready: true });
  return { room: created.room, p1, p2, snap };
}

/** 決着するまで、手番の席が言われたとおりに答え続ける */
async function playOut(svc: RoomService, room: string, seats: Seated[]): Promise<RoomSnapshot> {
  let guard = 0;
  for (;;) {
    if (++guard > 500) throw new Error('決着しない');
    let acted = false;
    for (const s of seats) {
      const snap = await svc.snapshot(room, s.seat, s.token);
      if (snap.status === 'over') return snap;
      if (!snap.pending) continue;
      await svc.handle({
        t: 'choose',
        room,
        ...s,
        index: snap.pending.index,
        answer: firstAnswer(snap.pending),
      });
      acted = true;
    }
    if (!acted) {
      const snap = await svc.snapshot(room, seats[0]!.seat, seats[0]!.token);
      if (snap.status === 'over') return snap;
      throw new Error('誰の手番でもないのに終わっていない');
    }
  }
}

// ============================================================

describe('ロビー', () => {
  it('部屋を作ると席とトークンが返り、プリセットが並ぶ', async () => {
    const { svc } = service();
    const snap = await svc.handle({ t: 'create', name: 'あなた', deck: { preset: 'earth' } });

    assert.equal(snap.status, 'lobby');
    assert.equal(snap.you?.seat, 'P1');
    assert.ok(snap.you?.token);
    assert.equal(snap.seats.length, 1);
    assert.equal(snap.seats[0]?.god, 'earth');
    assert.ok((snap.presets ?? []).length >= 4);
  });

  it('2人目が入って両者が準備すると対戦が始まる', async () => {
    const { svc } = service();
    const { snap } = await openRoom(svc);
    assert.equal(snap.status, 'playing');
    assert.equal(snap.seats.length, 2);
  });

  it('貼り付けたデッキを持ち込める', async () => {
    const { svc } = service();
    const created = await svc.handle({ t: 'create', name: 'あなた', deck: { text: DECK_TEXTS.sea! } });
    assert.equal(created.seats[0]?.god, 'sea');
    assert.equal(created.seats[0]?.deckName, '海コントロール');
  });

  it('壊れたデッキは行番号つきで弾く', async () => {
    const { svc } = service();
    await assert.rejects(
      () => svc.handle({ t: 'create', name: 'あなた', deck: { text: 'god: earth\n3 紅蓮着人' } }),
      /行目/,
    );
  });

  it('同じ神同士は組ませない（先行度が並ぶため）', async () => {
    const { svc } = service();
    const created = await svc.handle({ t: 'create', name: 'あなた', deck: { preset: 'earth' } });
    const joined = await svc.handle({ t: 'join', room: created.room, name: 'あいて' });
    await assert.rejects(
      () => svc.handle({ t: 'deck', room: created.room, ...joined.you!, deck: { preset: 'earth' } }),
      /同じ神同士/,
    );
  });

  it('3人目は入れない', async () => {
    const { svc } = service();
    const { room } = await openRoom(svc);
    await assert.rejects(() => svc.handle({ t: 'join', room, name: '3人目' }), /埋まっている/);
  });
});

describe('対戦', () => {
  it('2人で最後まで打てる', async () => {
    const { svc } = service();
    const { room, p1, p2 } = await openRoom(svc);
    const end = await playOut(svc, room, [p1, p2!]);

    assert.equal(end.status, 'over');
    assert.ok(end.result, '結果が入る');
    assert.ok(end.result!.winner === 'P1' || end.result!.winner === 'P2');
  });

  it('AI の神は毎回同じにならない（先頭固定にしない）', async () => {
    const { svc } = service();
    const gods = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const snap = await svc.handle({ t: 'create', name: 'あなた', deck: { preset: 'earth' }, vsAi: true });
      const ai = snap.seats.find((x) => x.ai)!;
      assert.notEqual(ai.god, 'earth', '自分と同じ神は選ばない');
      gods.add(ai.god!);
    }
    assert.ok(gods.size >= 2, `30回作って ${[...gods].join(',')} しか出ていない`);
  });

  it('AI のデッキを指名できる', async () => {
    const { svc } = service();
    const snap = await svc.handle({
      t: 'create',
      name: 'あなた',
      deck: { preset: 'earth' },
      vsAi: true,
      aiDeck: { preset: 'sky' },
    });
    const ai = snap.seats.find((x) => x.ai)!;
    assert.equal(ai.god, 'sky');
    assert.equal(ai.deckName, '空天候');
  });

  it('AI に自分と同じ神は指名できない', async () => {
    const { svc } = service();
    await assert.rejects(
      () =>
        svc.handle({ t: 'create', name: 'あなた', deck: { preset: 'earth' }, vsAi: true, aiDeck: { preset: 'earth' } }),
      /同じ神同士/,
    );
  });

  it('AIと1人でも最後まで打てる', async () => {
    const { svc } = service();
    const { room, p1 } = await openRoom(svc, { vsAi: true });
    const end = await playOut(svc, room, [p1]);

    assert.equal(end.status, 'over');
    assert.ok(end.result);
  });

  it('自分の手番のときだけ選択が届く', async () => {
    const { svc } = service();
    const { room, p1, p2 } = await openRoom(svc);
    const a = await svc.snapshot(room, p1.seat, p1.token);
    const b = await svc.snapshot(room, p2!.seat, p2!.token);
    assert.notEqual(Boolean(a.pending), Boolean(b.pending), 'どちらか一方だけが待たれている');
  });

  it('投了で相手の勝ちになる', async () => {
    const { svc } = service();
    const { room, p1, p2 } = await openRoom(svc);
    const end = await svc.handle({ t: 'surrender', room, ...p1 });
    assert.equal(end.status, 'over');
    assert.equal(end.result?.winner, p2!.seat);
    assert.equal(end.result?.reason, '降伏');
  });
});

describe('不正な入力', () => {
  async function pendingOf(svc: RoomService, room: string, s: Seated): Promise<PendingRequest> {
    const snap = await svc.snapshot(room, s.seat, s.token);
    assert.ok(snap.pending, `${s.seat} の手番ではない`);
    return snap.pending;
  }

  it('トークンが違えば拒む', async () => {
    const { svc } = service();
    const { room, p1 } = await openRoom(svc);
    await assert.rejects(
      () => svc.handle({ t: 'choose', room, seat: p1.seat, token: 'にせもの', index: 0, answer: [0] }),
      /権限/,
    );
  });

  it('相手の手番には割り込めない', async () => {
    const { svc } = service();
    const { room, p1, p2 } = await openRoom(svc);
    const waiting = (await svc.snapshot(room, p1.seat, p1.token)).pending ? p1 : p2!;
    const other = waiting === p1 ? p2! : p1;
    await assert.rejects(
      () => svc.handle({ t: 'choose', room, ...other, index: 0, answer: [0] }),
      /手番/,
    );
  });

  it('範囲外の番号は弾く', async () => {
    const { svc } = service();
    const { room, p1, p2 } = await openRoom(svc);
    const turn = (await svc.snapshot(room, p1.seat, p1.token)).pending ? p1 : p2!;
    const pending = await pendingOf(svc, room, turn);
    await assert.rejects(
      () => svc.handle({ t: 'choose', room, ...turn, index: pending.index, answer: [999] }),
      /存在しません/,
    );
  });

  it('二重送信・遅れて届いた応答は素通しで無視する', async () => {
    const { svc } = service();
    const { room, p1, p2 } = await openRoom(svc);
    const turn = (await svc.snapshot(room, p1.seat, p1.token)).pending ? p1 : p2!;
    const pending = await pendingOf(svc, room, turn);

    const after = await svc.handle({ t: 'choose', room, ...turn, index: pending.index, answer: firstAnswer(pending) });
    // まったく同じものをもう一度送る（回線の再送のつもり）
    const again = await svc.handle({ t: 'choose', room, ...turn, index: pending.index, answer: firstAnswer(pending) });

    assert.equal(again.version, after.version, '2度目は状態を進めない');
  });
});

describe('再接続', () => {
  it('席のトークンさえあれば、同じ盤面と同じ待ち選択が戻ってくる', async () => {
    const { svc } = service();
    const { room, p1, p2 } = await openRoom(svc);
    const turn = (await svc.snapshot(room, p1.seat, p1.token)).pending ? p1 : p2!;

    const before = await svc.snapshot(room, turn.seat, turn.token);
    // 「リロードした」＝ 何も覚えていない状態からもう一度取り直す
    const after = await svc.snapshot(room, turn.seat, turn.token);

    assert.deepEqual(after.pending, before.pending);
    assert.equal(after.version, before.version);
    assert.equal(after.view?.me.handCount, before.view?.me.handCount);
  });

  it('トークンが無ければ盤面は見えない（観戦にはならない）', async () => {
    const { svc } = service();
    const { room } = await openRoom(svc);
    const snap = await svc.snapshot(room);
    assert.equal(snap.view, undefined);
    assert.equal(snap.pending, undefined);
    assert.ok(snap.seats.length === 2, '席の並びだけは見える');
  });
});
