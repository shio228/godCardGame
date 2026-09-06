/**
 * Vercel に渡す成果物を作る（Build Output API v3 = `.vercel/output/`）。
 *
 *   npm run build          # 対戦画面と一緒に作られる
 *
 * ## なぜ自分で束ねるのか
 *
 * リポジトリの根に `api/*.ts` を置くと、Vercel は**それを自分で1ファイルだけ JS に変換して**置く。
 * このリポジトリは ESM（`package.json` の `"type": "module"`）なので、
 * Node は**拡張子を補完しない**——`../src/net/routes` は実行時に解決できず、
 * 関数が起動前に落ちる（`ERR_MODULE_NOT_FOUND` → ブラウザには `FUNCTION_INVOCATION_FAILED`）。
 *
 * そこで**こちらで esbuild で1ファイルに束ねてから渡す**。
 * 束ねた後の関数には相対 import が1つも残らないので、向こう側の解決の仕方に依存しない。
 *
 * **入口は `server/functions/` に置く。** 根に `api/` があると Vercel の自動検出が
 * それを拾って自前でビルドしてしまい、こちらの成果物が使われない（実際に踏んだ）。
 *
 * ## 出来上がり
 *
 * ```
 * .vercel/output/
 *   config.json                       経路（api 以外は index.html に流す）
 *   static/index.html                 対戦画面
 *   functions/api/<name>.func/
 *     .vc-config.json                 ランタイムの指定
 *     index.mjs                       束ねた関数（既定 export が (req,res)）
 * ```
 */
import { buildSync } from 'esbuild';
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = '.vercel/output';
const API_DIR = 'server/functions';
/** Vercel 側の Node。ここで指定しておくと、プロジェクト設定に左右されない */
const RUNTIME = 'nodejs22.x';

export function functionNames(dir = API_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => f.replace(/\.ts$/, ''))
    .sort();
}

/** 1本の関数を1ファイルに束ねる。**相対 import を残さない**のが目的 */
export function bundleFunction(name: string, dir = API_DIR): string {
  const built = buildSync({
    entryPoints: [join(dir, `${name}.ts`)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    minify: true,
    write: false,
    logLevel: 'warning',
  });
  const file = built.outputFiles[0];
  if (!file) throw new Error(`${name} のバンドルが生成されなかった`);
  return file.text;
}

/**
 * ランタイムの指定。
 * `launcherType: 'Nodejs'` は**既定 export の `(req, res)`** を呼ぶ。
 * `shouldAddHelpers` で本文が先に解析されるが、`src/net/node-bridge.ts` がその形も受ける。
 */
function vcConfig(): string {
  return JSON.stringify(
    { runtime: RUNTIME, handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: true },
    null,
    2,
  );
}

/** 経路。`/api/*` は関数、それ以外は対戦画面1枚に流す */
function routes(): string {
  return JSON.stringify(
    {
      version: 3,
      routes: [{ handle: 'filesystem' }, { src: '/(?!api/).*', dest: '/index.html' }],
    },
    null,
    2,
  );
}

export function buildVercelOutput(clientHtml = 'public/index.html'): string[] {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, 'static'), { recursive: true });
  cpSync(clientHtml, join(OUT, 'static/index.html'));
  writeFileSync(join(OUT, 'config.json'), routes(), 'utf-8');

  const names = functionNames();
  for (const name of names) {
    const dir = join(OUT, 'functions/api', `${name}.func`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.vc-config.json'), vcConfig(), 'utf-8');
    writeFileSync(join(dir, 'index.mjs'), bundleFunction(name), 'utf-8');
  }
  return names;
}

if (process.argv[1]?.endsWith('build-vercel.ts') === true) {
  const names = buildVercelOutput();
  console.log(`${OUT} を書き出した（関数 ${names.length}本: ${names.map((n) => `/api/${n}`).join(' ')}）`);
}
