/**
 * 対話プレイ。ターミナルで自分で1試合打つ。
 *
 *   npm run play                                        # あなた(P1) vs 目的志向AI(P2)
 *   npm run play -- --deck1 decks/sea.txt --deck2 decks/life.txt
 *   npm run play -- --you both                          # 2人で交互（ホットシート）
 *   npm run play -- --you none                          # AI同士を眺める
 *   npm run play -- --seed 42 --record tmp/game.json    # 記録して後で再生
 *   npm run play -- --ai random                         # 相手を弱くする
 *
 * 記録した試合は `npm run replay -- --in tmp/game.json` でそのまま再生でき、
 * ダッシュボードのリプレイにも載せられる（人の選択も全部記録されるため）。
 */
import { createInterface } from 'node:readline/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { samplePool } from '../src/rules/cards.sample';
import { loadDeckFile } from '../src/rules/decks.load';
import { GreedyChooser } from '../src/engine/ai';
import { PerPlayerChooser, RandomChooser, type Chooser } from '../src/engine/chooser';
import type { Engine } from '../src/engine/context';
import { recordGame } from '../src/engine/replay';
import { objectiveProgress } from '../src/engine/progress';
import { HumanChooser, formatLine, renderBoard } from './human';
import type { PlayerId } from '../src/rules/types';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

function optional(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * 1行ずつ読む。**届いた行を溜める**ので、パイプで一気に流し込んでも動く
 * （`readline.question` だけだと、質問していない間に届いた行が捨てられる）。
 * 入力が尽きたら例外にして試合を止める — 空文字を返し続けると
 * 「選ばないことはできません」で無限に聞き直すことになるため。
 */
function lineReader(): { ask: (prompt: string) => Promise<string>; close: () => void } {
  const queue: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  let closed = false;

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true,
  });
  rl.on('line', (line) => {
    const w = waiting.shift();
    if (w) w(line);
    else queue.push(line);
  });
  rl.on('close', () => {
    closed = true;
    for (const w of waiting.splice(0)) w('');
  });

  return {
    ask: (prompt) => {
      process.stdout.write(prompt);
      const line = queue.shift();
      if (line !== undefined) return Promise.resolve(line);
      if (closed) return Promise.reject(new Error('入力が尽きました（試合の途中で終了します）'));
      return new Promise<string>((resolve) => waiting.push(resolve));
    },
    close: () => rl.close(),
  };
}

async function main(): Promise<void> {
  const deck1 = loadDeckFile(arg('deck1', 'decks/earth.txt'));
  const deck2 = loadDeckFile(arg('deck2', 'decks/sky.txt'));
  const you = arg('you', 'P1');
  const aiKind = arg('ai', 'greedy');
  const seed = Number(arg('seed', String(Date.now() % 100000)));
  const recordTo = optional('record');

  const humanSeats: PlayerId[] = you === 'both' ? ['P1', 'P2'] : you === 'none' ? [] : [you as PlayerId];
  const names: Record<PlayerId, string> = { P1: deck1.name, P2: deck2.name };

  const input = humanSeats.length > 0 ? lineReader() : undefined;
  const human = input ? new HumanChooser({ ask: input.ask, names }) : undefined;

  const attach: ((e: Engine) => void)[] = [];
  const seatChooser = (pid: PlayerId): Chooser => {
    if (human && humanSeats.includes(pid)) {
      attach.push((e) => human.attach(e));
      return human;
    }
    if (aiKind === 'random') return new RandomChooser(seed + (pid === 'P1' ? 0 : 1));
    const greedy = new GreedyChooser({ fallback: new RandomChooser(seed) });
    attach.push((e) => greedy.attach(e));
    return greedy;
  };

  const chooser = new PerPlayerChooser({ P1: seatChooser('P1'), P2: seatChooser('P2') });

  console.log(`\n${deck1.name}（${deck1.god} / P1） vs ${deck2.name}（${deck2.god} / P2）`);
  console.log(`あなた: ${humanSeats.length === 0 ? 'なし（観戦）' : humanSeats.join(' と ')}  /  相手: ${aiKind}  /  seed ${seed}`);
  if (human) console.log('操作: 数字で選択 / 空Enterでパス / b 盤面 / l ログ / q 投了 / ? ヘルプ');

  const { record, engine } = await recordGame({
    pool: samplePool,
    p1God: deck1.god,
    p2God: deck2.god,
    decks: { P1: deck1, P2: deck2 },
    seed,
    chooser,
    onEngine: (e) => attach.forEach((f) => f(e)),
  });

  // 締め
  if (human) human.flushLog();
  else console.log(engine.log.map(formatLine).join('\n'));

  const r = record.result;
  console.log(renderBoard(engine, humanSeats[0] ?? 'P1', names));
  console.log('');
  if (r.error) {
    console.log(`エラーで終了: ${r.error}`);
  } else {
    const winner = r.winner === 'P1' ? names.P1 : r.winner === 'P2' ? names.P2 : '引き分け';
    console.log(`${winner} の勝ち（サイクル ${r.cycles} / ${r.reason ?? ''}）`);
  }

  for (const pid of ['P1', 'P2'] as PlayerId[]) {
    console.log(`\n${names[pid]} の勝利条件`);
    for (const p of await objectiveProgress(engine, pid)) {
      const pct = p.progress === undefined ? ' -- ' : `${String(Math.round(100 * p.progress)).padStart(3)}%`;
      console.log(`  ${p.revealed ? '公開' : '伏せ'} ${pct}  ${p.objective.name}  ${p.detail}`);
    }
  }

  if (recordTo) {
    mkdirSync(dirname(recordTo), { recursive: true });
    writeFileSync(recordTo, JSON.stringify(record, null, 2), 'utf-8');
    console.log(`\n記録: ${recordTo}（npm run replay -- --in ${recordTo} で再生）`);
  }
  input?.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
