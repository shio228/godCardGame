/**
 * `(req, res)` で呼ばれる形の入口。
 *
 * ホスティングによっては Web標準の名前付き export ではなく
 * **従来の `(req, res)` の既定 export しか見ない**。そちらで呼ばれても
 * 同じ経路に入り、同じ JSON が返ることをここで押さえる。
 */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { samplePool } from '../rules/cards.sample';
import { nodeHandler, toRequest } from './node-bridge';
import { RoomService } from './room';
import { gameRoute } from './routes';
import { MemoryStore } from './store';
import type { RoomSnapshot } from './protocol';

/** `node:http` の要求（本文はストリームで届く） */
function incoming(opts: { method?: string; url: string; body?: string; parsed?: unknown }): IncomingMessage {
  const stream = Readable.from(opts.body === undefined ? [] : [Buffer.from(opts.body, 'utf-8')]);
  const req = stream as unknown as IncomingMessage & { body?: unknown };
  req.method = opts.method ?? 'GET';
  req.url = opts.url;
  req.headers = { host: 'example.test', 'content-type': 'application/json' };
  if (opts.parsed !== undefined) req.body = opts.parsed;
  return req;
}

/** 書き込まれたものを溜めるだけの応答 */
function recorder(): { res: ServerResponse; done: Promise<{ status: number; headers: Record<string, string>; body: string }> } {
  const headers: Record<string, string> = {};
  let resolve!: (v: { status: number; headers: Record<string, string>; body: string }) => void;
  const done = new Promise<{ status: number; headers: Record<string, string>; body: string }>((r) => (resolve = r));

  const res = {
    statusCode: 200,
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = v;
    },
    end(chunk?: Uint8Array | string) {
      const body = chunk === undefined ? '' : typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
      resolve({ status: res.statusCode, headers, body });
    },
  };
  return { res: res as unknown as ServerResponse, done };
}

function service(): RoomService {
  return new RoomService({ pool: samplePool, store: new MemoryStore() });
}

describe('(req, res) の入口', () => {
  it('本文がストリームで届く場合', async () => {
    const svc = service();
    const handler = nodeHandler((request) => gameRoute(request, svc));
    const { res, done } = recorder();

    await handler(
      incoming({
        method: 'POST',
        url: '/api/game',
        body: JSON.stringify({ t: 'create', name: 'あなた', deck: { preset: 'earth' } }),
      }),
      res,
    );

    const out = await done;
    assert.equal(out.status, 200);
    assert.match(out.headers['content-type'] ?? '', /application\/json/);
    const snap = JSON.parse(out.body) as RoomSnapshot;
    assert.equal(snap.seats[0]?.god, 'earth');
  });

  it('ホスティングが先に本文を読んで `req.body` に置いた場合', async () => {
    const svc = service();
    const handler = nodeHandler((request) => gameRoute(request, svc));
    const { res, done } = recorder();

    // ストリームは空。解析済みの本文だけが渡ってくる（Vercel の Node ランタイム）
    await handler(
      incoming({
        method: 'POST',
        url: '/api/game',
        parsed: { t: 'create', name: 'あなた', deck: { preset: 'sea' } },
      }),
      res,
    );

    const out = await done;
    assert.equal(out.status, 200, out.body);
    assert.equal((JSON.parse(out.body) as RoomSnapshot).seats[0]?.god, 'sea');
  });

  it('経路が投げても JSON で返す（素のエラーページにしない）', async () => {
    const handler = nodeHandler(() => Promise.reject(new Error('こわれた')));
    const { res, done } = recorder();

    await handler(incoming({ url: '/api/game' }), res);

    const out = await done;
    assert.equal(out.status, 500);
    assert.match(out.headers['content-type'] ?? '', /application\/json/);
    assert.match((JSON.parse(out.body) as { error: string }).error, /こわれた/);
  });

  it('URL と見出しがそのまま渡る', async () => {
    const request = await toRequest(incoming({ url: '/api/v?room=ABC123' }));
    assert.equal(new URL(request.url).pathname, '/api/v');
    assert.equal(new URL(request.url).searchParams.get('room'), 'ABC123');
    assert.equal(request.headers.get('content-type'), 'application/json');
  });
});
