/**
 * 費用のテスト。**遊べるかどうかと同じくらい、止まらないかどうかが要る。**
 *
 * Vercel の Functions は実行時間で課金されるので、
 * 「盤面を作り直す（＝エンジンを回す）」のが**選択のときだけ**であることを
 * 設計の性質としてここで押さえる。ポーリングは1試合で数百〜千回起きるため、
 * そこにエンジンが1回でも混ざると桁が変わる。
 *
 * 併せて1試合ぶんの再生時間を実測して出す（上限を割ったら落とす）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { samplePool } from '../rules/cards.sample';
import { RoomService } from './room';
import { MemoryStore } from './store';
import { resumeGame } from './resume';
import type { RoomStore, StoredRoom } from './store';
import type { PendingRequest } from './protocol';
import type { PlayerId } from '../rules/types';

/** 1試合ぶんの再生に許す合計時間 */
const TIME_BUDGET_MS = 10_000;

/** 保存先への操作を数える。ポーリングが本体JSONを読まないことを見るため */
class CountingStore implements RoomStore {
  readonly counts = { create: 0, get: 0, set: 0, version: 0 };
  private readonly inner = new MemoryStore();

  create(room: StoredRoom): Promise<void> {
    this.counts.create++;
    return this.inner.create(room);
  }
  get(id: string): Promise<StoredRoom | undefined> {
    this.counts.get++;
    return this.inner.get(id);
  }
  compareAndSet(id: string, v: number, next: StoredRoom): Promise<boolean> {
    this.counts.set++;
    return this.inner.compareAndSet(id, v, next);
  }
  version(id: string): Promise<number | undefined> {
    this.counts.version++;
    return this.inner.version(id);
  }
}

function firstAnswer(p: PendingRequest): number[] | number | boolean {
  if (p.t === 'confirm') return true;
  if (p.t === 'number') return p.min ?? 0;
  const options = p.options ?? [];
  if (p.t === 'order') return options.map((_, i) => i);
  const n = Math.min(Math.max(p.min ?? 0, 1), Math.min(p.max ?? 1, options.length));
  return options.slice(0, n).map((_, i) => i);
}

describe('費用', () => {
  it('ポーリングはエンジンを回さない。回すのは選択が入ったときだけ', async () => {
    const store = new CountingStore();
    let resumes = 0;
    const svc = new RoomService({
      pool: samplePool,
      store,
      resume: (...args) => {
        resumes++;
        return resumeGame(...args);
      },
    });

    const created = await svc.handle({ t: 'create', name: 'あなた', deck: { preset: 'earth' }, vsAi: true, seed: 777 });
    const me = created.you!;
    const room = created.room;

    let choices = 0;
    let polls = 0;
    const started = performance.now();

    for (let guard = 0; guard < 500; guard++) {
      // 相手（AI）の手番を待つあいだのポーリング。版番号だけを何度も読む
      for (let i = 0; i < 5; i++) {
        await svc.version(room);
        polls++;
      }
      const snap = await svc.snapshot(room, me.seat, me.token);
      if (snap.status === 'over') break;
      assert.ok(snap.pending, '自分の手番のはず（AI は advance の中で答え切る）');
      await svc.handle({ t: 'choose', room, ...me, index: snap.pending.index, answer: firstAnswer(snap.pending) });
      choices++;
    }
    const elapsed = performance.now() - started;

    const recorded = (await store.get(room))!.doc.choices.length;

    assert.ok(choices > 5, `選択が起きた（${choices}件）`);
    assert.ok(polls > 50, `ポーリングを重ねた（${polls}回）`);

    // 要点は「再生の回数がポーリングではなく**記録された選択**に比例する」こと。
    // AI の席は1手ごとに再生し直して答えさせるので、その分も記録に入っている
    assert.equal(resumes, recorded + 1, '再生は「記録された選択 + 最後の1回」だけ');
    assert.equal(store.counts.version, polls, '版番号の読み出しはポーリングの回数ぶん');
    assert.ok(
      store.counts.get < polls,
      `ポーリングは本体JSONを読まない（get ${store.counts.get}回 < poll ${polls}回）`,
    );

    // eslint-disable-next-line no-console -- 実測値は人が見るために出す
    console.log(
      `      1試合: 自分の選択 ${choices}件 / 記録 ${recorded}件（AI ${recorded - choices}件）/ 再生 ${resumes}回 / ポーリング ${polls}回 / 合計 ${elapsed.toFixed(0)}ms（1再生あたり ${(elapsed / resumes).toFixed(1)}ms）`,
    );
    assert.ok(elapsed < TIME_BUDGET_MS, `1試合の合計が上限を超えた: ${elapsed.toFixed(0)}ms > ${TIME_BUDGET_MS}ms`);
  });

  it('盤面の取得（/api/state 相当）もエンジンを回さない', async () => {
    const store = new CountingStore();
    let resumes = 0;
    const svc = new RoomService({
      pool: samplePool,
      store,
      resume: (...args) => {
        resumes++;
        return resumeGame(...args);
      },
    });

    const created = await svc.handle({ t: 'create', name: 'あなた', deck: { preset: 'earth' }, vsAi: true });
    const me = created.you!;
    const after = resumes;

    for (let i = 0; i < 30; i++) await svc.snapshot(created.room, me.seat, me.token);

    assert.equal(resumes, after, '保存済みのビューを返すだけ');
  });

  it('版番号は保存先の1回の読み出しで済む', async () => {
    const store = new CountingStore();
    const svc = new RoomService({ pool: samplePool, store });
    const created = await svc.handle({ t: 'create', name: 'あなた', deck: { preset: 'earth' } });

    const before = { ...store.counts };
    const v = await svc.version(created.room);

    assert.equal(v, created.version);
    assert.equal(store.counts.version, before.version + 1);
    assert.equal(store.counts.get, before.get, '本体には触らない');
  });

  it('席の無い部屋の版番号を聞かれても落ちない', async () => {
    const svc = new RoomService({ pool: samplePool, store: new MemoryStore() });
    assert.equal(await svc.version('ZZZZZZ'), undefined);
  });
});

describe('保存先の約束', () => {
  const seats: PlayerId[] = ['P1', 'P2'];

  it('版が合ったときだけ書ける（同時更新を弾く）', async () => {
    const store = new MemoryStore();
    const doc: StoredRoom = {
      doc: {
        id: 'AAAAAA',
        version: 1,
        status: 'lobby',
        seats: {},
        vsAi: false,
        seed: 1,
        choices: [],
        createdAt: 0,
        updatedAt: 0,
      },
      views: {},
    };
    await store.create(doc);

    const next = structuredClone(doc);
    next.doc.version = 2;
    assert.equal(await store.compareAndSet('AAAAAA', 1, next), true, '版が合えば書ける');
    assert.equal(await store.compareAndSet('AAAAAA', 1, next), false, '古い版では書けない');
    assert.equal(await store.version('AAAAAA'), 2);
    assert.equal(await store.compareAndSet('ZZZZZZ', 1, next), false, '無い部屋には書けない');
    assert.equal(seats.length, 2);
  });

  it('取り出した文書をいじっても保存先は変わらない', async () => {
    const store = new MemoryStore();
    await store.create({
      doc: { id: 'BBBBBB', version: 1, status: 'lobby', seats: {}, vsAi: false, seed: 1, choices: [], createdAt: 0, updatedAt: 0 },
      views: {},
    });

    const got = (await store.get('BBBBBB'))!;
    got.doc.version = 99;
    assert.equal((await store.get('BBBBBB'))!.doc.version, 1, '写しが返る');
  });
});
