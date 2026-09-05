/**
 * HTTP の経路。中身は `RoomService` に任せてあるので、
 * ここで見るのは**受け渡しと、経路ごとの重さの線引き**。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { samplePool } from '../rules/cards.sample';
import { RoomService } from './room';
import { MemoryStore } from './store';
import { versionRoute } from './route.version';
import { gameRoute, stateRoute } from './routes';
import type { RoomSnapshot, VersionResponse } from './protocol';

function fixture(): { svc: RoomService; store: MemoryStore } {
  const store = new MemoryStore();
  return { svc: new RoomService({ pool: samplePool, store }), store };
}

function post(body: unknown): Request {
  return new Request('http://x/api/game', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('経路', () => {
  it('部屋を作って、盤面を取りにいける', async () => {
    const { svc, store } = fixture();
    const res = await gameRoute(post({ t: 'create', name: 'あなた', deck: { preset: 'earth' }, vsAi: true }), svc);
    const created = (await res.json()) as RoomSnapshot;

    assert.equal(created.status, 'playing', 'AI 戦はその場で始まる');
    const you = created.you!;

    const state = await stateRoute(
      new Request(`http://x/api/state?room=${created.room}&seat=${you.seat}&token=${you.token}`),
      svc,
    );
    assert.equal(state.status, 200);
    const snap = (await state.json()) as RoomSnapshot;
    assert.equal(snap.room, created.room);
    assert.ok(snap.view, '自分の盤面が入る');

    const v = (await (await versionRoute(new Request(`http://x/api/v?room=${created.room}`), store)).json()) as VersionResponse;
    assert.equal(v.version, snap.version);
  });

  it('版が変わっていなければ 304 で本文を送らない', async () => {
    const { svc } = fixture();
    const created = (await (await gameRoute(post({ t: 'create', name: 'あなた', deck: { preset: 'sea' } }), svc)).json()) as RoomSnapshot;
    const you = created.you!;
    const url = `http://x/api/state?room=${created.room}&seat=${you.seat}&token=${you.token}`;

    const first = await stateRoute(new Request(url), svc);
    const etag = first.headers.get('etag')!;
    assert.ok(etag);

    const again = await stateRoute(new Request(url, { headers: { 'if-none-match': etag } }), svc);
    assert.equal(again.status, 304);
    assert.equal(await again.text(), '');
  });

  it('無い部屋の版番号は null（エラーにしない。ポーリングの相手なので）', async () => {
    const { store } = fixture();
    const res = await versionRoute(new Request('http://x/api/v?room=ZZZZZZ'), store);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { room: 'ZZZZZZ', version: null });
  });

  it('room が無ければ 400', async () => {
    const { store } = fixture();
    assert.equal((await versionRoute(new Request('http://x/api/v'), store)).status, 400);
  });

  it('知らない操作・壊れた JSON は 400（500 にしない）', async () => {
    const { svc } = fixture();
    assert.equal((await gameRoute(post({ t: 'なにか' }), svc)).status, 400);
    assert.equal(
      (await gameRoute(new Request('http://x/api/game', { method: 'POST', body: '{' }), svc)).status,
      400,
    );
    assert.equal((await gameRoute(new Request('http://x/api/game'), svc)).status, 405);
  });

  it('ルール上ありえない入力は 400 で理由が返る', async () => {
    const { svc } = fixture();
    const res = await gameRoute(post({ t: 'join', room: 'ZZZZZZ', name: 'だれか' }), svc);
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /部屋が見つからない/);
  });
});

// ============================================================

/**
 * 費用の線引きを**構造として**押さえる。
 * ポーリングの経路にエンジンが載ると、1回0.4秒×数百回という桁になる。
 * 「今は呼んでいない」ではなく「そもそも import されていない」まで見る。
 */
describe('ポーリング経路の重さ', () => {
  const ROOT = resolve('.');

  /** 実行時に読み込まれる import だけを辿る（`import type` は消えるので数えない） */
  function imports(file: string): string[] {
    const src = readFileSync(file, 'utf-8');
    const out: string[] = [];
    const re = /(?:^|\n)\s*(?:import|export)(?!\s+type\b)[^;\n]*?from\s*['"]([^'"]+)['"]/g;
    for (const m of src.matchAll(re)) out.push(m[1]!);
    for (const m of src.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) out.push(m[1]!);
    return out;
  }

  function reachable(entry: string): string[] {
    const seen = new Set<string>();
    const stack = [resolve(entry)];
    while (stack.length > 0) {
      const file = stack.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const spec of imports(file)) {
        if (!spec.startsWith('.')) continue;
        const next = resolve(join(dirname(file), spec.endsWith('.ts') ? spec : `${spec}.ts`));
        stack.push(next);
      }
    }
    return [...seen].map((f) => relative(ROOT, f).split('\\').join('/'));
  }

  it('api/v.ts はエンジンにもカードデータにも辿り着かない', () => {
    const files = reachable('api/v.ts');
    const heavy = files.filter((f) => f.startsWith('src/engine/') || f.startsWith('src/rules/'));
    assert.deepEqual(heavy, [], `版番号の経路が重いものを引き込んでいる: ${heavy.join(', ')}`);
    assert.ok(files.includes('src/net/route.version.ts'));
  });

  it('操作の経路（api/game.ts）はエンジンを持っている', () => {
    const files = reachable('api/game.ts');
    assert.ok(
      files.some((f) => f.startsWith('src/engine/')),
      '再生するのだから当然エンジンが要る（対比のための確認）',
    );
  });
});
