/**
 * 自動対戦の実行と集計。`simulate`（表示）と `dashboard`（HTML）が共有する。
 *
 * 打ち手は2種類:
 *   - `random` … `RandomChooser`。一様ランダム。「何も考えない基準値」
 *   - `greedy` … `GreedyChooser`。勝利条件の進捗と相手ライフを見て選ぶ
 *
 * 集計では**達成できなかった勝利条件が「どこまで行ったか」**も出す。
 * 達成率0%が「達成不能」なのか「AIが踏めていないだけ」なのかを切り分けるため。
 */
import { samplePool } from '../src/rules/cards.sample';
import { DECKS_DIR, loadDeck, loadDeckFile } from '../src/rules/decks.load';
import { GreedyChooser } from '../src/engine/ai';
import { PerPlayerChooser, RandomChooser, type Chooser } from '../src/engine/chooser';
import type { Engine } from '../src/engine/context';
import { objectiveProgress } from '../src/engine/progress';
import { recordGame, type GameRecord } from '../src/engine/replay';
import type { God, PlayerId } from '../src/rules/types';

export type AiKind = 'random' | 'greedy';

export interface Outcome {
  p1God: God;
  p2God: God;
  index: number;
  seed: number;
  ai: { P1: AiKind; P2: AiKind };
  winner?: PlayerId | 'draw';
  cycles: number;
  reason: string;
  /** 決着した時点で先攻だったプレイヤー */
  firstAtEnd: PlayerId;
  error?: string;
  /** 決着時点の勝利条件の達成度（勝利条件ID → 0〜1）。測れないものは入らない */
  progress: Record<string, number>;
}

/**
 * 1試合ぶんのシード。`--games` の指定に依らず、
 * (基準シード, 神, 神, 何戦目) が同じなら必ず同じ値になる。
 */
export function gameSeed(base: number, p1God: God, p2God: God, index: number): number {
  let h = base >>> 0;
  for (const ch of `${p1God}|${p2God}|${index}`) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
  return h >>> 0;
}

function makeChooser(kind: AiKind, seed: number): { chooser: Chooser; attach?: (e: Engine) => void } {
  if (kind === 'random') return { chooser: new RandomChooser(seed) };
  const greedy = new GreedyChooser({ fallback: new RandomChooser(seed) });
  return { chooser: greedy, attach: (e) => greedy.attach(e) };
}

export interface PlayOptions {
  p1God: God;
  p2God: God;
  index: number;
  seed: number;
  ai: { P1: AiKind; P2: AiKind };
  /** デッキファイルの置き場（既定 decks/） */
  decksDir?: string;
  /** 神ごとにデッキファイルを名指しする（`--deck` で渡す。置き場より優先） */
  deckFiles?: Partial<Record<God, string>>;
}

/** その神のデッキ。名指しがあればそれを、無ければ置き場の `<god>.txt` を読む */
export function deckFor(god: God, o: { decksDir?: string | undefined; deckFiles?: Partial<Record<God, string>> | undefined }) {
  const named = o.deckFiles?.[god];
  return named !== undefined ? loadDeckFile(named) : loadDeck(god, o.decksDir ?? DECKS_DIR);
}

export async function playOne(o: PlayOptions): Promise<{ outcome: Outcome; record: GameRecord }> {
  const a = makeChooser(o.ai.P1, o.seed);
  const b = makeChooser(o.ai.P2, o.seed ^ 0x9e3779b9);
  const { record, engine } = await recordGame({
    pool: samplePool,
    p1God: o.p1God,
    p2God: o.p2God,
    decks: { P1: deckFor(o.p1God, o), P2: deckFor(o.p2God, o) },
    seed: o.seed,
    chooser: new PerPlayerChooser({ P1: a.chooser, P2: b.chooser }),
    onEngine: (e) => {
      a.attach?.(e);
      b.attach?.(e);
    },
  });

  const progress: Record<string, number> = {};
  for (const pid of ['P1', 'P2'] as PlayerId[]) {
    try {
      for (const p of await objectiveProgress(engine, pid)) {
        if (p.progress !== undefined) {
          progress[p.objective.id] = Math.max(progress[p.objective.id] ?? 0, p.progress);
        }
      }
    } catch {
      // 決着直後の盤面で測れないことがある。集計用なので握りつぶす
    }
  }

  const r = record.result;
  const outcome: Outcome = {
    p1God: o.p1God,
    p2God: o.p2God,
    index: o.index,
    seed: o.seed,
    ai: o.ai,
    cycles: r.cycles,
    reason: r.error ? 'エラー' : (r.reason ?? '不明'),
    firstAtEnd: engine.state.first,
    progress,
    ...(r.winner !== undefined ? { winner: r.winner } : {}),
    ...(r.error !== undefined ? { error: r.error } : {}),
  };
  return { outcome, record };
}

export interface RunOptions {
  games: number;
  seed: number;
  gods: God[];
  ai: { P1: AiKind; P2: AiKind };
  decksDir?: string;
  deckFiles?: Partial<Record<God, string>>;
  /** 記録を受け取るコールバック（保存したいときだけ） */
  onRecord?: (outcome: Outcome, record: GameRecord) => void;
}

/** 同神対決はルール上起こらないので組み合わせに入れない */
export function matchups(gods: God[]): [God, God][] {
  const pairs: [God, God][] = [];
  for (const a of gods) for (const b of gods) if (a !== b) pairs.push([a, b]);
  return pairs;
}

export async function runMatches(opts: RunOptions): Promise<Outcome[]> {
  const pairs = matchups(opts.gods);
  if (pairs.length === 0) throw new Error('対戦する組み合わせがない（神を2つ以上指定する）');
  const perPair = Math.max(1, Math.round(opts.games / pairs.length));

  const out: Outcome[] = [];
  for (const [a, b] of pairs) {
    for (let i = 0; i < perPair; i++) {
      const seed = gameSeed(opts.seed, a, b, i);
      const { outcome, record } = await playOne({
        p1God: a,
        p2God: b,
        index: i,
        seed,
        ai: opts.ai,
        ...(opts.decksDir !== undefined ? { decksDir: opts.decksDir } : {}),
        ...(opts.deckFiles !== undefined ? { deckFiles: opts.deckFiles } : {}),
      });
      out.push(outcome);
      opts.onRecord?.(outcome, record);
    }
  }
  return out;
}

// ============================================================
// 集計
// ============================================================

export interface ObjectiveStat {
  id: string;
  name: string;
  god: God;
  /** 勝因になった回数 */
  wins: number;
  /** 達成率（決着した試合のうち） */
  rate: number;
  /** 達成できなかった試合も含めた、到達した達成度の平均と最大 */
  meanProgress?: number;
  maxProgress?: number;
}

/**
 * 対戦カードごとの「先攻だったとき / 後攻だったとき」の勝率。
 * 神の強さと相手の相性を両方固定したうえで先攻の効果だけを見るための形。
 */
export interface FirstAdvantage {
  /** 神の組（順不同）。勝率は pair[0] から見た値 */
  pair: [God, God];
  asFirst: { rate: number; games: number };
  asSecond: { rate: number; games: number };
  /** 先攻時 − 後攻時。正なら先攻が有利 */
  delta?: number;
}

export interface Summary {
  label: string;
  games: number;
  decided: number;
  errors: { message: string; seed: number; p1God: God; p2God: God }[];
  avgCycles: number;
  cycleDist: { cycle: number; n: number }[];
  /**
   * 決着時に先攻だった側の勝率。
   * **神の強さと交絡している**ことに注意 — 先行度は勝利条件に固定で振られているので、
   * 先行度の低い神（大地 1/3/6）はほぼ常に先攻になる。
   * 交絡を除いた数字は `firstAdvantage` / `firstAdvantageMean` を見る。
   */
  firstWinRate: number;
  firstAdvantage: FirstAdvantage[];
  /** 各神の（先攻時勝率 − 後攻時勝率）の平均。神の強さを打ち消した先攻の有利さ */
  firstAdvantageMean?: number;
  /** 神 → 総合勝率 */
  byGod: { god: God; rate: number; games: number }[];
  /** [P1の神][P2の神] → P1の勝率 */
  matrix: { p1: God; p2: God; rate: number; games: number }[];
  reasons: { reason: string; n: number; rate: number }[];
  /** 特殊勝利で決着した割合 */
  objectiveWinRate: number;
  objectives: ObjectiveStat[];
}

/** 差を採用するのに必要な、両側の最低試合数 */
const MIN_BUCKET = 5;

/**
 * 先攻の有利さを、神の強さと相性から切り離して測る。
 *
 * 「先攻の勝率」をそのまま出すと交絡する。先行度は勝利条件に固定で振られていて
 * 神とほぼ1対1に対応するので、**先行度の低い神が強いだけ**でも先攻有利に見える。
 * 神ごとに分けても足りない（大地が先攻なのは主に海が相手のときで、
 * 後攻なのは生命が相手のときなので、相手の強さが混ざる）。
 *
 * そこで**同じ対戦カードの中で**「その神が先攻だった試合 / 後攻だった試合」を比べる。
 * 神も相手も固定されるので、残るのは先攻後攻の差だけになる。
 * 対称なので、どちらの神から見ても差は同じ符号になる（打ち消し合わない）。
 */
function firstAdvantageOf(
  decided: Outcome[],
  gods: God[],
): { firstAdvantage: FirstAdvantage[]; firstAdvantageMean?: number } {
  const rows: FirstAdvantage[] = [];
  for (let i = 0; i < gods.length; i++) {
    for (let j = i + 1; j < gods.length; j++) {
      const a = gods[i]!;
      const b = gods[j]!;
      const first = { won: 0, n: 0 };
      const second = { won: 0, n: 0 };
      for (const o of decided) {
        const involves = (o.p1God === a && o.p2God === b) || (o.p1God === b && o.p2God === a);
        if (!involves) continue;
        const side: PlayerId = o.p1God === a ? 'P1' : 'P2';
        const bucket = o.firstAtEnd === side ? first : second;
        bucket.n++;
        if (o.winner === side) bucket.won++;
      }
      const row: FirstAdvantage = {
        pair: [a, b],
        asFirst: { rate: first.n === 0 ? 0 : first.won / first.n, games: first.n },
        asSecond: { rate: second.n === 0 ? 0 : second.won / second.n, games: second.n },
      };
      if (first.n >= MIN_BUCKET && second.n >= MIN_BUCKET) row.delta = row.asFirst.rate - row.asSecond.rate;
      rows.push(row);
    }
  }
  const deltas = rows.map((r) => r.delta).filter((d): d is number => d !== undefined);
  return {
    firstAdvantage: rows,
    ...(deltas.length > 0 ? { firstAdvantageMean: deltas.reduce((a, b) => a + b, 0) / deltas.length } : {}),
  };
}

export function summarize(label: string, outcomes: Outcome[], gods: God[]): Summary {
  const done = outcomes.filter((o) => !o.error);
  const decided = done.filter((o) => o.winner === 'P1' || o.winner === 'P2');
  const dist = new Map<number, number>();
  for (const o of done) dist.set(o.cycles, (dist.get(o.cycles) ?? 0) + 1);

  const reasons = new Map<string, number>();
  for (const o of done) reasons.set(o.reason, (reasons.get(o.reason) ?? 0) + 1);

  const objectives: ObjectiveStat[] = samplePool.objectives
    .filter((o) => gods.includes(o.god))
    .map((o) => {
      const wins = reasons.get(`勝利条件:${o.name}`) ?? 0;
      const seen = outcomes.map((x) => x.progress[o.id]).filter((x): x is number => x !== undefined);
      const stat: ObjectiveStat = {
        id: o.id,
        name: o.name,
        god: o.god,
        wins,
        rate: done.length === 0 ? 0 : wins / done.length,
      };
      if (seen.length > 0) {
        stat.meanProgress = seen.reduce((a, b) => a + b, 0) / seen.length;
        stat.maxProgress = Math.max(...seen);
      }
      return stat;
    });

  const objectiveWins = [...reasons.entries()]
    .filter(([r]) => r.startsWith('勝利条件:'))
    .reduce((a, [, n]) => a + n, 0);

  return {
    label,
    games: outcomes.length,
    decided: done.length,
    errors: outcomes
      .filter((o) => o.error)
      .map((o) => ({ message: o.error!, seed: o.seed, p1God: o.p1God, p2God: o.p2God })),
    avgCycles: done.length === 0 ? 0 : done.reduce((a, o) => a + o.cycles, 0) / done.length,
    cycleDist: [...dist.entries()].sort((a, b) => a[0] - b[0]).map(([cycle, n]) => ({ cycle, n })),
    firstWinRate:
      decided.length === 0 ? 0 : decided.filter((o) => o.winner === o.firstAtEnd).length / decided.length,
    ...firstAdvantageOf(decided, gods),
    byGod: gods.map((g) => {
      const asP1 = decided.filter((o) => o.p1God === g);
      const asP2 = decided.filter((o) => o.p2God === g);
      const n = asP1.length + asP2.length;
      const wins = asP1.filter((o) => o.winner === 'P1').length + asP2.filter((o) => o.winner === 'P2').length;
      return { god: g, rate: n === 0 ? 0 : wins / n, games: n };
    }),
    matrix: matchups(gods).map(([p1, p2]) => {
      const set = decided.filter((o) => o.p1God === p1 && o.p2God === p2);
      return {
        p1,
        p2,
        games: set.length,
        rate: set.length === 0 ? 0 : set.filter((o) => o.winner === 'P1').length / set.length,
      };
    }),
    reasons: [...reasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => ({ reason, n, rate: done.length === 0 ? 0 : n / done.length })),
    objectiveWinRate: done.length === 0 ? 0 : objectiveWins / done.length,
    objectives,
  };
}
