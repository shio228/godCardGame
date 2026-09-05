/**
 * `GET /api/v?room=…` — 版番号だけ返す。
 *
 * **1試合で数百〜千回叩かれる経路。** エンジンもカードデータも import していない
 * （辿るのは `src/net/route.version.ts` → `store.factory` だけ）。
 * この一線は `src/net/routes.test.ts` が構造として見張っている。
 */
import { versionRoute } from '../src/net/route.version';

export function GET(request: Request): Promise<Response> {
  return versionRoute(request);
}
