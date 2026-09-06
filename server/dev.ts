/**
 * ローカルの対戦サーバ。**Vercel が無くても2人で遊べる。**
 *
 *   npm run serve            # http://localhost:5173
 *   PORT=8080 npm run serve
 *
 * 経路の中身は `api/` と同じ関数（`src/net/routes.ts`）を呼ぶだけ。
 * `node:http` との橋渡しも `api/` と同じもの（`src/net/node-bridge.ts`）を使う。
 * ここ独自なのは `public/` の静的配信だけで、**本番と別のロジックを持たない**のが狙い。
 *
 * 保存先は既定でメモリ（プロセスを止めると部屋も消える）。
 * `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` があれば Redis を使う。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

import { sendResponse, toRequest } from '../src/net/node-bridge';
import { versionRoute } from '../src/net/route.version';
import { gameRoute, stateRoute } from '../src/net/routes';

const ROOT = resolve('public');
const PORT = Number(process.env.PORT ?? 5173);

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

async function handle(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === '/api/v') return versionRoute(request);
  if (path === '/api/state') return stateRoute(request);
  if (path === '/api/game') return gameRoute(request);
  return serveStatic(path);
}

/** `public/` を配る。無ければ `index.html`（画面側の経路はクライアントが持つ） */
async function serveStatic(path: string): Promise<Response> {
  const rel = normalize(path === '/' ? '/index.html' : path).replace(/^[/]+/, '');
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT)) return new Response('だめ', { status: 403 });

  for (const candidate of [file, join(ROOT, 'index.html')]) {
    try {
      if ((await stat(candidate)).isFile()) {
        const body = await readFile(candidate);
        return new Response(new Uint8Array(body), {
          headers: { 'content-type': TYPES[extname(candidate)] ?? 'application/octet-stream', 'cache-control': 'no-store' },
        });
      }
    } catch {
      // 次の候補へ
    }
  }
  return new Response('まだ画面がありません（npm run build で public/index.html を作る）', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

createServer((req, res) => {
  void (async () => {
    try {
      await sendResponse(res, await handle(await toRequest(req, `localhost:${PORT}`)));
    } catch (e) {
      // ここに来るのは橋渡しの不具合。経路の中の失敗は JSON で返っている
      res.statusCode = 500;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
  })();
}).listen(PORT, () => {
  const where = process.env.UPSTASH_REDIS_REST_URL ? 'Upstash Redis' : 'メモリ（停めると部屋は消える）';
  console.log(`対戦サーバ: http://localhost:${PORT}  保存先: ${where}`);
});
