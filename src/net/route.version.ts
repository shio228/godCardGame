/**
 * 版番号を返すだけの経路（`GET /api/v?room=…`）。
 *
 * **1試合で数百〜千回叩かれる。** ここが軽いかどうかで費用が決まるので、
 * ファイルを分けて依存を切ってある——このモジュールは
 * **エンジンにもカードデータにも触らない**（保存先の小さいキーを1回読むだけ）。
 */
import { storeFromEnv } from './store.factory';
import type { RoomStore } from './store';
import type { VersionResponse } from './protocol';

export async function versionRoute(req: Request, store: RoomStore = storeFromEnv()): Promise<Response> {
  const room = new URL(req.url).searchParams.get('room');
  if (room === null || room === '') {
    return json({ error: 'room が要る' }, 400);
  }
  const version = await store.version(room);
  const body: VersionResponse = { room, version: version ?? null };
  return json(body, 200);
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}
