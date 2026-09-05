/**
 * 対戦画面を1枚のHTMLにする（`public/index.html`）。
 *
 *   npm run build
 *   npm run build -- --out tmp/game.html
 *
 * React ごと esbuild で束ねて `<script>` に埋め込む。**外部からJSを読まない**ので、
 * `public/` をそのまま配れば動く（Vercel の静的配信でも、`npm run serve` でも同じ）。
 */
import { buildSync } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { renderClient } from './client.template';

const ENTRY = 'src/browser/game.entry.tsx';

export function bundleClient(minify = true): string {
  const built = buildSync({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'iife',
    target: 'es2022',
    jsx: 'automatic',
    minify,
    write: false,
    logLevel: 'warning',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const file = built.outputFiles[0];
  if (!file) throw new Error('バンドルが生成されなかった');
  return file.text;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

function main(): void {
  const out = arg('out', 'public/index.html');
  const bundle = bundleClient(!process.argv.includes('--dev'));
  const html = renderClient(bundle);

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html, 'utf-8');
  console.log(`${out} を書き出した（${(html.length / 1024).toFixed(0)}KB / JS ${(bundle.length / 1024).toFixed(0)}KB）`);
}

if (process.argv[1]?.endsWith('build-client.ts') === true) main();
