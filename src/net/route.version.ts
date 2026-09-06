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

export async function versionRoute(req: Request, store?: RoomStore): Promise<Response> {
  const room = new URL(req.url).searchParams.get('room');
  if (room === null || room === '') {
    return json({ error: 'room が要る' }, 400);
  }
  try {
    // 保存先の用意もこの中で。既定引数にすると、設定不足の例外が
    // ここの捕捉より先に飛んで、素のエラーページが返ってしまう
    const version = await (store ?? storeFromEnv()).version(room);
    const body: VersionResponse = { room, version: version ?? null };
    return json(body, 200);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return json({ room, version: null, error: message }, 500);
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}
