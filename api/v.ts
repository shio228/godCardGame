/**
 * `GET /api/v?room=…` — 版番号だけ返す。
 *
 * **1試合で数百〜千回叩かれる経路。** エンジンもカードデータも import していない
 * （辿るのは `src/net/route.version.ts` → `store.factory` だけ）。
 * この一線は `src/net/routes.test.ts` が構造として見張っている。
 *
 * Web標準の名前付き export と、従来の `(req, res)` の既定 export を**両方**出す。
 * どちらを見るかはホスティング次第なので、片方だけだと環境によって関数が起動しない。
 */
import { nodeHandler } from '../src/net/node-bridge';
import { versionRoute } from '../src/net/route.version';

export function GET(request: Request): Promise<Response> {
  return versionRoute(request);
}

export default nodeHandler(versionRoute);
