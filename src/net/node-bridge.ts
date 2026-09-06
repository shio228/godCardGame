/**
 * `node:http` の `(req, res)` と、Web標準の `Request` / `Response` の橋渡し。
 *
 * 経路の中身（`routes.ts` / `route.version.ts`）はWeb標準だけで書いてあるが、
 * **呼び出し側の作法はホスティングによって違う**。
 *
 * - ローカルの `server/dev.ts` … `node:http` の `(req, res)`
 * - Vercel … Build Output API の Node ランチャは `export default (req, res)` を呼ぶ。
 *   Web標準の名前付き export（`GET` / `POST`）を見る構成もあるので両方出してある
 *
 * どちらで呼ばれても同じ経路に入るよう、変換をここ1か所に置く。
 * **ブラウザ用のバンドルには入らない**（`server/` からしか import しない）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** `(req, res)` を Web標準の `Request` に直す */
export async function toRequest(req: IncomingMessage, fallbackHost = 'localhost'): Promise<Request> {
  const host = req.headers.host ?? fallbackHost;
  const url = `http://${host}${req.url ?? '/'}`;

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }

  const method = req.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD') return new Request(url, { method, headers });
  return new Request(url, { method, headers, body: await readBody(req) });
}

/**
 * 本文を取る。
 *
 * **ホスティングが先に読んで `req.body` に置いていることがある**（Vercel の Node ランタイムは
 * `content-type: application/json` の本文を解析して渡す）。その場合ストリームはもう空なので、
 * 読み直すと本文なしになってしまう。先に `req.body` を見る。
 */
async function readBody(req: IncomingMessage): Promise<string | ArrayBuffer> {
  const parsed = (req as IncomingMessage & { body?: unknown }).body;
  if (parsed !== undefined && parsed !== null) {
    if (typeof parsed === 'string') return parsed;
    if (parsed instanceof Uint8Array) return new Uint8Array(parsed).buffer;
    return JSON.stringify(parsed);
  }

  const chunks: Uint8Array[] = [];
  for await (const c of req) chunks.push(c as Uint8Array);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out.buffer;
}

/** Web標準の `Response` を `(req, res)` の `res` に書き出す */
export async function sendResponse(res: ServerResponse, out: Response): Promise<void> {
  res.statusCode = out.status;
  out.headers.forEach((v, k) => res.setHeader(k, v));
  if (out.body === null) {
    res.end();
    return;
  }
  res.end(new Uint8Array(await out.arrayBuffer()));
}

/**
 * Web標準の経路を、従来の `(req, res)` ハンドラに包む。
 * `server/functions/*.ts` の `export default` に使う（この形しか見ないホスティングのため）。
 */
export function nodeHandler(
  route: (request: Request) => Promise<Response>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      await sendResponse(res, await route(await toRequest(req)));
    } catch (e) {
      // ここに来るのは橋渡しの不具合。経路の中の失敗は JSON で返っている。
      // それでも**JSONで返す**——素のエラーページはクライアントが読めない
      const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: `サーバ側で落ちた: ${message}` }));
    }
  };
}
