/**
 * ダッシュボードの生成。
 *
 *   npm run dashboard                       # tmp/dashboard.html を作る
 *   npm run dashboard -- --games 240        # 自動対戦の試合数
 *   npm run dashboard -- --out docs/dash.html
 *   npm run dashboard -- --fragment         # <html> の枠なし（Artifact 公開用）
 *   npm run dashboard -- --quick            # 自動対戦を減らして速く作る
 *
 * 型検査・テスト・煙テストは子プロセスで実際に走らせ、自動対戦は同じプロセスで回す。
 * リプレイに載せる試合は自動対戦から拾う（毎回同じシードなので再現できる）。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { DECKS_DIR, PLAYABLE_GODS } from '../src/rules/decks.load';
import type { GameRecord } from '../src/engine/replay';
import { renderDashboard, type DashboardData, type TestSuite } from './dashboard.template';
import { runMatches, summarize, type Outcome } from './stats';
import type { God } from '../src/rules/types';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

/**
 * 子プロセスを走らせて出力を取る。失敗しても出力は返す（結果を画面に出すのが目的なので）。
 * `shell` は使わない（Windows でも `node` は直接起動できる）。
 */
function run(args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync(process.execPath, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

// ============================================================
// テスト
// ============================================================

const TEST_LINE = /^(\s*)([✔✖]) (.+?) \(([\d.]+)ms\)$/;
const SUITE_LINE = /^(\s*)▶ (.+)$/;

/** `npm test` と同じ範囲（src/ と tools/ の *.test.ts）を集める */
function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...testFiles(path));
    else if (e.name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

function collectTests(): DashboardData['tests'] {
  const files = [...testFiles('src'), ...testFiles('tools')];
  const { out } = run(['--import', 'tsx', '--test', ...files]);

  const suites: TestSuite[] = [];
  let current: TestSuite | undefined;
  let pass = 0;
  let fail = 0;

  for (const raw of out.split(/\r?\n/)) {
    const suite = SUITE_LINE.exec(raw);
    if (suite && suite[1]!.length === 0) {
      current = { name: suite[2]!.trim(), tests: [] };
      suites.push(current);
      continue;
    }
    const m = TEST_LINE.exec(raw);
    if (!m) continue;
    // インデント0の ✔/✖ は「スイート全体の結果」なので数えない
    if (m[1]!.length === 0) continue;
    const ok = m[2] === '✔';
    if (ok) pass++;
    else fail++;
    if (!current) {
      current = { name: '（トップレベル）', tests: [] };
      suites.push(current);
    }
    current.tests.push({ name: m[3]!.trim(), ok, ms: Number(m[4]) });
  }
  return { total: pass + fail, pass, fail, suites };
}

// ============================================================
// 煙テスト
// ============================================================

function collectSweep(): DashboardData['sweep'] {
  const { out } = run(['--import', 'tsx', 'tools/sweep.ts']);
  const head = /成功 (\d+) \/ (\d+)/.exec(out);
  const failures: { message: string; cards: string[] }[] = [];
  const lines = out.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*\[(\d+)\] (.+)$/.exec(lines[i]!);
    if (!m) continue;
    const cards = (lines[i + 1] ?? '').trim().split(' / ').filter(Boolean);
    failures.push({ message: m[2]!.trim(), cards });
  }
  return { ok: head ? Number(head[1]) : 0, total: head ? Number(head[2]) : 0, failures };
}

// ============================================================
// 自動対戦
// ============================================================

async function collectSim(games: number, seed: number, gods: God[], decksDir: string): Promise<{
  sim: DashboardData['sim'];
  replays: DashboardData['replays'];
}> {
  const replays: DashboardData['replays'] = [];
  const keep = new Map<string, { label: string; record: GameRecord }>();

  const remember = (tag: string) => (o: Outcome, rec: GameRecord) => {
    // 1組につき1試合だけ、リプレイ用に残す（エラーが出た試合は優先して残す）
    const key = `${tag}:${o.p1God}-${o.p2God}`;
    if (!keep.has(key) || o.error) {
      keep.set(key, {
        label: `${tag}　${o.p1God} vs ${o.p2God}`,
        record: rec,
      });
    }
  };

  const randomOut = await runMatches({ games, seed, gods, decksDir, ai: { P1: 'random', P2: 'random' } });
  const greedyOut = await runMatches({
    games,
    seed,
    gods,
    decksDir,
    ai: { P1: 'greedy', P2: 'greedy' },
    onRecord: remember('目的志向'),
  });
  const headA = await runMatches({ games: Math.round(games / 2), seed, gods, decksDir, ai: { P1: 'greedy', P2: 'random' } });
  const headB = await runMatches({ games: Math.round(games / 2), seed, gods, decksDir, ai: { P1: 'random', P2: 'greedy' } });
  const head = [...headA, ...headB];
  const decided = head.filter((o) => o.winner === 'P1' || o.winner === 'P2');
  const greedyWins = decided.filter((o) => (o.ai.P1 === 'greedy' ? o.winner === 'P1' : o.winner === 'P2')).length;

  for (const [, v] of keep) replays.push({ id: v.label, label: v.label, record: v.record });

  return {
    sim: {
      games,
      seed,
      random: summarize('ランダムAI', randomOut, gods),
      greedy: summarize('目的志向AI', greedyOut, gods),
      head: { games: head.length, winRate: decided.length === 0 ? 0 : greedyWins / decided.length },
    },
    replays,
  };
}

// ============================================================

async function main(): Promise<void> {
  const quick = process.argv.includes('--quick');
  const games = Number(arg('games', quick ? '48' : '240'));
  const seed = Number(arg('seed', '1'));
  const gods = arg('gods', PLAYABLE_GODS.join(',')).split(',') as God[];
  const decksDir = arg('decks', DECKS_DIR);
  const out = arg('out', 'tmp/dashboard.html');
  const fragment = process.argv.includes('--fragment');

  process.stdout.write('型検査… ');
  const typecheck = run(['node_modules/typescript/bin/tsc', '--noEmit']);
  console.log(typecheck.ok ? 'クリーン' : '失敗');

  process.stdout.write('テスト… ');
  const tests = collectTests();
  console.log(`${tests.pass}/${tests.total}`);

  process.stdout.write('煙テスト… ');
  const sweep = collectSweep();
  console.log(`${sweep.ok}/${sweep.total}`);

  process.stdout.write(`自動対戦（各 ${games} 戦）… `);
  const { sim, replays } = await collectSim(games, seed, gods, decksDir);
  console.log(`エラー ${sim.random.errors.length + sim.greedy.errors.length}`);

  const data: DashboardData = {
    generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 16),
    typecheck: { ok: typecheck.ok, output: typecheck.out },
    tests,
    sweep,
    sim,
    replays,
  };

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderDashboard(data, { standalone: !fragment }), 'utf-8');
  console.log(`\n${out} を書き出した（リプレイ ${replays.length} 試合）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
