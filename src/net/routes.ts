/**
 * 盤面と操作の経路。HTTP をここで受け、中身は `RoomService` に渡すだけ。
 *
 * Web 標準の `Request` / `Response` で書いてあるので、
 * Vercel Functions でも `node:http` のローカルサーバでも、テストからの直接呼び出しでも
 * 同じものが動く（`server/dev.ts` と `api/` は、この関数を呼ぶだけの薄い層）。
 *
 * 版番号の経路だけは `route.version.ts` に分けてある（エンジンを載せないため）。
 */
import { samplePool } from '../rules/cards.sample';
import { RoomService, RoomError } from './room';
import { ResumeError } from './resume';
import { StoreConfigError, storeFromEnv } from './store.factory';
import { json } from './route.version';
import type { RoomStore } from './store';
import type { ClientAction, RoomSnapshot } from './protocol';
import type { PlayerId } from '../rules/types';

const ACTIONS = ['create', 'join', 'deck', 'ready', 'choose', 'surrender'] as const;

let cached: RoomService | undefined;

export function serviceFromEnv(store?: RoomStore): RoomService {
  if (store) return new RoomService({ pool: samplePool, store });
  cached ??= new RoomService({ pool: samplePool, store: storeFromEnv() });
  return cached;
}

/** `GET /api/state?room=&seat=&token=` — 保存済みのビューを返す。エンジンは回さない */
export async function stateRoute(req: Request, svc?: RoomService): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const room = q.get('room');
  if (room === null || room === '') return json({ error: 'room が要る' }, 400);

  const seat = q.get('seat');
  const token = q.get('token');
  return run(async () => {
    // **サービスの用意も try の中で。** 既定引数にすると本体より先に評価されるので、
    // 設定不足の例外がここの捕捉をすり抜けて、素のエラーページがそのまま返っていた
    const service = svc ?? serviceFromEnv();
    const snap = await service.snapshot(
      room,
      seat === 'P1' || seat === 'P2' ? (seat as PlayerId) : undefined,
      token ?? undefined,
    );
    // 版が同じなら中身は同じ。変わっていないときは本文を送らない
    const etag = `W/"${snap.version}"`;
    if (req.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { etag, 'cache-control': 'no-store' } });
    }
    return json(snap, 200, { etag });
  });
}

/** `POST /api/game` — 操作を1件受ける。**エンジンを回すのはここだけ** */
export async function gameRoute(req: Request, svc?: RoomService): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'POST で送る' }, 405);
  return run(async () => {
    const service = svc ?? serviceFromEnv();
    const action = await parseAction(req);
    const snap: RoomSnapshot = await service.handle(action);
    return json(snap, 200);
  });
}

async function parseAction(req: Request): Promise<ClientAction> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new RoomError('JSON が読めない');
  }
  if (typeof body !== 'object' || body === null) throw new RoomError('操作が入っていない');
  const t = (body as { t?: unknown }).t;
  if (typeof t !== 'string' || !ACTIONS.includes(t as (typeof ACTIONS)[number])) {
    throw new RoomError(`知らない操作: ${String(t)}`);
  }
  return body as ClientAction;
}

/**
 * 例外を応答に直す。
 * ルール上ありえない入力（400）と、こちらの不具合（500）を混ぜない。
 */
async function run(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof StoreConfigError) {
      // 保存先が無い。これは設定の問題なので、直し方をそのまま返す
      return json({ error: `保存先が設定されていません: ${e.message}` }, 500);
    }
    if (e instanceof RoomError || e instanceof ResumeError) return json({ error: e.message }, 400);
    if (e instanceof Error && /行目|デッキ|勝利条件/.test(e.message)) return json({ error: e.message }, 400);
    const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return json({ error: `サーバ側で落ちた: ${message}` }, 500);
  }
}
