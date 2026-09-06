/**
 * Vercel に渡す成果物。
 *
 * ここで落とすのは**本番でしか起きない壊れ方**——
 * 「関数が起動する前に相対 import を解決できずに落ちる」やつ。
 * 一度実際に踏んだので、束ねた結果に相対 import が残っていないことと、
 * **束ねたものが実際に読み込めて応答を返すこと**を毎回確かめる。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';

import { bundleFunction, functionNames } from './build-vercel';

/** 束ねた関数を実際に読み込む（Vercel と同じ「1ファイルを import する」形） */
async function load(name: string): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), 'vercel-func-'));
  try {
    const file = join(dir, `${name}.mjs`);
    writeFileSync(file, bundleFunction(name), 'utf-8');
    return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `(req, res)` の作法で呼ぶ。本文は解析済みで渡す（`shouldAddHelpers` と同じ） */
async function callDefault(
  mod: Record<string, unknown>,
  opts: { method?: string; url: string; body?: unknown },
): Promise<{ status: number; body: string }> {
  const req = Readable.from([]) as Readable & Record<string, unknown>;
  req.method = opts.method ?? 'GET';
  req.url = opts.url;
  req.headers = { host: 'example.test', 'content-type': 'application/json' };
  if (opts.body !== undefined) req.body = opts.body;

  let status = 0;
  let body = '';
  const res = {
    statusCode: 200,
    setHeader() {},
    end(chunk?: Uint8Array | string) {
      status = res.statusCode;
      body = chunk === undefined ? '' : typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    },
  };

  const handler = mod.default;
  assert.equal(typeof handler, 'function', `${opts.url}: 既定 export が関数でない`);
  await (handler as (r: unknown, s: unknown) => Promise<void> | void)(req, res);
  return { status, body };
}

describe('Vercel に渡す関数', () => {
  it('経路のぶんだけ関数がある', () => {
    const names = functionNames();
    for (const need of ['game', 'state', 'v']) assert.ok(names.includes(need), `${need} が無い`);
  });

  it('束ねた結果に相対 import が残っていない（本番で解決できずに落ちるため）', () => {
    for (const name of functionNames()) {
      const code = bundleFunction(name);
      const found = [...code.matchAll(/(?:from|import)\s*["'](\.[^"']*)["']/g)].map((m) => m[1]);
      assert.deepEqual(found, [], `${name}: 相対 import が残っている`);
      assert.match(code, /export\s*\{[^}]*as default/, `${name}: 既定 export が無い`);
    }
  });

  it('束ねたものを読み込んで、(req, res) で呼べる', async () => {
    const ping = await load('ping');
    const out = await callDefault(ping, { url: '/api/ping' });
    assert.equal(out.status, 200);
    assert.equal((JSON.parse(out.body) as { ok: boolean }).ok, true);
  });

  it('版番号の経路は、保存先が無くても JSON で答える', async () => {
    const saved = { ...process.env };
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.VERCEL;
    try {
      const mod = await load('v');
      const out = await callDefault(mod, { url: '/api/v?room=TEST' });
      assert.equal(out.status, 200);
      assert.deepEqual(JSON.parse(out.body), { room: 'TEST', version: null });
    } finally {
      process.env = saved;
    }
  });

  it('操作の経路は、束ねた状態でも1試合を始められる', async () => {
    const saved = { ...process.env };
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.VERCEL; // メモリの保存先で動かす
    try {
      const mod = await load('game');
      const out = await callDefault(mod, {
        method: 'POST',
        url: '/api/game',
        body: { t: 'create', name: 'あなた', deck: { preset: 'earth' }, vsAi: true },
      });
      assert.equal(out.status, 200, out.body);
      const snap = JSON.parse(out.body) as { status: string; seats: { god?: string }[] };
      assert.equal(snap.status, 'playing', 'AI 戦はその場で始まる');
      assert.equal(snap.seats.length, 2);
    } finally {
      process.env = saved;
    }
  });
});
