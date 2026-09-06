/**
 * 切り分け用の探針。**import を1つも持たない。**
 *
 * `/api/ping` が動くかどうかで、原因が二分できる:
 *
 * - **動く** … 関数の仕組みと呼び出しの作法は正しい。原因は他のファイルの読み込み側
 *   （相対 import の解決・ビルド設定）にある
 * - **動かない** … プロジェクトの設定側（ランタイム、ビルド、`api/` の扱い）の問題
 *
 * 秘密は出さない。環境変数は**有る／無いだけ**を返す。
 */

interface NodeResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

function report(): string {
  return JSON.stringify(
    {
      ok: true,
      node: process.version,
      region: process.env.VERCEL_REGION ?? null,
      env: process.env.VERCEL_ENV ?? null,
      // 値は出さない。入っているかどうかだけ
      hasRedisUrl: Boolean(process.env.UPSTASH_REDIS_REST_URL),
      hasRedisToken: Boolean(process.env.UPSTASH_REDIS_REST_TOKEN),
    },
    null,
    2,
  );
}

/** Web標準の作法で呼ばれた場合 */
export function GET(): Response {
  return new Response(report(), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** 従来の `(req, res)` で呼ばれた場合 */
export default function handler(_req: unknown, res: NodeResponse): void {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(report());
}
