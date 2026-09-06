/**
 * 記録と再生。
 *
 * 1試合を**完全に再現できる形**で記録し、あとから同じ試合を再実行する。
 * 自動対戦で落ちた試合を手元で1手ずつ追うためのもの。
 *
 * ## なぜ選択を全部記録するのか
 *
 * エンジンの乱数は `GameState.rng`（シード固定のLCG）だけなので、
 * **シードとデッキが同じなら盤面の乱数は完全に再現できる**。
 * `Math.random` も時刻も使っていない。
 *
 * それでも足りないのは「プレイヤーが何を選んだか」で、これは `Chooser` の外側にある。
 * `RandomChooser` なら同じシードで同じ選択になるが、人間やUIが打った試合はそうならない。
 * そこで **`Chooser` の応答を1件ずつ記録し、再生時はそれを読み上げる**形にした。
 * この形なら打ち手の種類（ランダム / AI / 人間 / UI）を問わず同じように再生できる。
 *
 * ## ずれの検出
 *
 * 再生中に「記録と違う選択を求められた」ら `ReplayError` を投げる。
 * 記録した選択肢のラベルと、再生時の選択肢のラベルを毎回突き合わせているので、
 * **エンジンの挙動が変わると再生が失敗する**。これは仕様で、退行の検出に使える。
 */
import type { CardPool, God, PlayerId, Weather } from '../rules/types';
import { RandomChooser, type ChoiceKind, type Chooser, type ConfirmRequest, type NumberRequest, type OrderRequest, type SelectRequest } from './chooser';
import type { Engine, LogEntry } from './context';
import { EngineError } from './errors';
import { createEngine, runGame, startGame, type DeckList } from './flow';

/**
 * 記録フォーマットの版。エンジン側の記録内容を変えたら上げる。
 *
 * v2: サイクルを0起点にした（企画書「基本ルール」）。0サイクル目にも
 *     スタックフェイズがあるので、選択の並びが v1 と噛み合わない。
 */
export const RECORD_VERSION = 2;

export class ReplayError extends EngineError {}

// ============================================================
// 記録の形
// ============================================================

/**
 * 選択1件の記録。
 * 値そのものではなく**選択肢の番号**で持つ（カードやスタック項目は毎回別のオブジェクトになるため）。
 * `labels` は再生時の突き合わせ用。
 */
export type RecordedChoice =
  | { t: 'select'; player: PlayerId; kind: ChoiceKind; prompt: string; picked: number[]; labels: string[] }
  | { t: 'number'; player: PlayerId; prompt: string; value: number }
  | { t: 'confirm'; player: PlayerId; prompt: string; value: boolean }
  | { t: 'order'; player: PlayerId; kind: ChoiceKind; prompt: string; picked: number[]; labels: string[] };

/** 試合を組み立てるのに必要な入力。ここが同じなら同じ試合になる */
export interface GameSetup {
  p1God: God;
  p2God: God;
  decks: { P1: DeckList; P2: DeckList };
  /** 盤面の乱数シード（シャッフル・ランダム選択） */
  seed: number;
  /** 記録時の打ち手のシード。再生には使わない（選択は記録から読む）が、出所の手掛かりとして残す */
  chooserSeed?: number;
  maxCycles?: number;
  objectiveMin?: number;
  budget?: number;
  life?: number;
  weather?: Weather;
  first?: PlayerId;
}

export interface GameOutcome {
  winner?: PlayerId | 'draw';
  cycles: number;
  reason?: string;
  /** 例外で終わった場合 */
  error?: string;
}

export interface GameRecord {
  version: number;
  setup: GameSetup;
  /** 全アクション（`Chooser` への応答）を発生順に */
  choices: RecordedChoice[];
  /** 進行ログ。人が読む用で、再生の一致判定にも使う */
  log: LogEntry[];
  result: GameOutcome;
}

// ============================================================
// 記録する Chooser / 再生する Chooser
// ============================================================

/** 値の配列を選択肢の番号に直す。同じ値が複数あっても番号が重ならないようにする */
function indicesOf<T>(options: readonly { value: T; label: string }[], values: readonly T[]): number[] {
  const used = new Set<number>();
  return values.map((v) => {
    const i = options.findIndex((o, k) => !used.has(k) && o.value === v);
    if (i < 0) throw new ReplayError('選択肢に無い値が返された（Chooser の実装を確認）');
    used.add(i);
    return i;
  });
}

/** 内側の Chooser の応答をそのまま通しつつ、1件ずつ記録する */
export class RecordingChooser implements Chooser {
  readonly choices: RecordedChoice[] = [];

  constructor(private readonly inner: Chooser) {}

  async select<T>(req: SelectRequest<T>): Promise<T[]> {
    const values = await this.inner.select(req);
    const picked = indicesOf(req.options, values);
    this.choices.push({
      t: 'select',
      player: req.player,
      kind: req.kind,
      prompt: req.prompt,
      picked,
      labels: picked.map((i) => req.options[i]!.label),
    });
    return values;
  }

  async number(req: NumberRequest): Promise<number> {
    const value = await this.inner.number(req);
    this.choices.push({ t: 'number', player: req.player, prompt: req.prompt, value });
    return value;
  }

  async confirm(req: ConfirmRequest): Promise<boolean> {
    const value = await this.inner.confirm(req);
    this.choices.push({ t: 'confirm', player: req.player, prompt: req.prompt, value });
    return value;
  }

  async order<T>(req: OrderRequest<T>): Promise<T[]> {
    const values = await this.inner.order(req);
    const picked = indicesOf(req.options, values);
    this.choices.push({
      t: 'order',
      player: req.player,
      kind: req.kind,
      prompt: req.prompt,
      picked,
      labels: picked.map((i) => req.options[i]!.label),
    });
    return values;
  }
}

/**
 * 記録した応答を順に読み上げる Chooser。
 * 求められた選択が記録と食い違ったら `ReplayError`（＝再生のずれ）。
 */
export class ReplayChooser implements Chooser {
  private i = 0;

  constructor(private readonly choices: readonly RecordedChoice[]) {}

  /** 消費した手数。最後まで再生できたかの確認に使う */
  get consumed(): number {
    return this.i;
  }

  private next<K extends RecordedChoice['t']>(
    t: K,
    player: PlayerId,
    prompt: string,
  ): Extract<RecordedChoice, { t: K }> {
    const c = this.choices[this.i];
    if (!c) throw new ReplayError(`記録が尽きた（${this.i + 1}手目に ${t}「${prompt}」を求められた）`);
    if (c.t !== t || c.player !== player || c.prompt !== prompt) {
      throw new ReplayError(
        `${this.i + 1}手目でずれた\n  記録: ${c.t} / ${c.player} / ${c.prompt}\n  再生: ${t} / ${player} / ${prompt}`,
      );
    }
    this.i++;
    return c as Extract<RecordedChoice, { t: K }>;
  }

  private pick<T>(rec: { picked: number[]; labels: string[] }, options: readonly { value: T; label: string }[]): T[] {
    return rec.picked.map((idx, k) => {
      const o = options[idx];
      if (!o) throw new ReplayError(`${this.i}手目: 選択肢 ${idx} が存在しない（選択肢は${options.length}件）`);
      if (o.label !== rec.labels[k]) {
        throw new ReplayError(`${this.i}手目でずれた\n  記録の選択肢: ${rec.labels[k]}\n  再生の選択肢: ${o.label}`);
      }
      return o.value;
    });
  }

  async select<T>(req: SelectRequest<T>): Promise<T[]> {
    return this.pick(this.next('select', req.player, req.prompt), req.options);
  }

  async number(req: NumberRequest): Promise<number> {
    return this.next('number', req.player, req.prompt).value;
  }

  async confirm(req: ConfirmRequest): Promise<boolean> {
    return this.next('confirm', req.player, req.prompt).value;
  }

  async order<T>(req: OrderRequest<T>): Promise<T[]> {
    return this.pick(this.next('order', req.player, req.prompt), req.options);
  }
}

// ============================================================
// 実行
// ============================================================

export interface RunOptions extends GameSetup {
  pool: CardPool;
}

function buildEngine(opts: RunOptions, chooser: Chooser): Engine {
  return createEngine({
    pool: opts.pool,
    p1God: opts.p1God,
    p2God: opts.p2God,
    seed: opts.seed,
    chooser,
    budget: opts.budget ?? 30000,
    ...(opts.life !== undefined ? { life: opts.life } : {}),
    ...(opts.weather !== undefined ? { weather: opts.weather } : {}),
    ...(opts.first !== undefined ? { first: opts.first } : {}),
  });
}

async function runToEnd(engine: Engine, opts: RunOptions): Promise<GameOutcome> {
  try {
    await startGame(engine, {
      P1: opts.decks.P1,
      P2: opts.decks.P2,
      ...(opts.objectiveMin !== undefined ? { objectiveMin: opts.objectiveMin } : {}),
    });
    const r = await runGame(engine, opts.maxCycles ?? 20);
    return {
      winner: r.winner,
      cycles: r.cycles,
      ...(engine.state.winReason !== undefined ? { reason: engine.state.winReason } : {}),
    };
  } catch (err) {
    const e = err as Error;
    return { cycles: engine.state.cycle, error: `${e.name}: ${e.message}` };
  }
}

/**
 * 1試合を記録つきで実行する。**例外で終わってもその時点までの記録を返す**
 * （落ちた試合を再生できることがこの仕組みの主目的）。
 */
export async function recordGame(
  opts: RunOptions & {
    chooser?: Chooser;
    /** エンジンを作った直後に呼ばれる。エンジンを見る打ち手（目的志向AI）を差すため */
    onEngine?: (engine: Engine) => void;
  },
): Promise<{
  record: GameRecord;
  engine: Engine;
}> {
  const seed = opts.chooserSeed ?? opts.seed;
  const recorder = new RecordingChooser(opts.chooser ?? new RandomChooser(seed));
  const engine = buildEngine(opts, recorder);
  opts.onEngine?.(engine);
  const result = await runToEnd(engine, opts);

  const setup: GameSetup = {
    p1God: opts.p1God,
    p2God: opts.p2God,
    decks: opts.decks,
    seed: opts.seed,
    chooserSeed: seed,
    ...(opts.maxCycles !== undefined ? { maxCycles: opts.maxCycles } : {}),
    ...(opts.objectiveMin !== undefined ? { objectiveMin: opts.objectiveMin } : {}),
    ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
    ...(opts.life !== undefined ? { life: opts.life } : {}),
    ...(opts.weather !== undefined ? { weather: opts.weather } : {}),
    ...(opts.first !== undefined ? { first: opts.first } : {}),
  };

  return {
    record: { version: RECORD_VERSION, setup, choices: recorder.choices, log: engine.log, result },
    engine,
  };
}

export interface ReplayResult {
  engine: Engine;
  result: GameOutcome;
  /** 記録と一致したか */
  matched: boolean;
  /** 食い違った点（空なら一致） */
  diff: string[];
  /** 読み上げた手数 / 記録の手数 */
  consumed: number;
  total: number;
}

/**
 * 記録した試合を再生する。
 * 選択は記録から読み上げるので、打ち手の種類に関係なく同じ試合が再現される。
 */
export async function replayGame(pool: CardPool, record: GameRecord): Promise<ReplayResult> {
  if (record.version !== RECORD_VERSION) {
    throw new ReplayError(`記録の版が違う（記録 v${record.version} / 現在 v${RECORD_VERSION}）`);
  }
  const chooser = new ReplayChooser(record.choices);
  const opts: RunOptions = { pool, ...record.setup };
  const engine = buildEngine(opts, chooser);
  const result = await runToEnd(engine, opts);

  const diff: string[] = [];
  const a = record.result;
  if (a.winner !== result.winner) diff.push(`勝者: 記録 ${a.winner} / 再生 ${result.winner}`);
  if (a.cycles !== result.cycles) diff.push(`決着サイクル: 記録 ${a.cycles} / 再生 ${result.cycles}`);
  if (a.reason !== result.reason) diff.push(`勝因: 記録 ${a.reason} / 再生 ${result.reason}`);
  if (a.error !== result.error) diff.push(`エラー: 記録 ${a.error ?? 'なし'} / 再生 ${result.error ?? 'なし'}`);
  if (record.log.length !== engine.log.length) {
    diff.push(`ログ行数: 記録 ${record.log.length} / 再生 ${engine.log.length}`);
  }
  const n = Math.min(record.log.length, engine.log.length);
  for (let i = 0; i < n; i++) {
    if (record.log[i]!.text !== engine.log[i]!.text) {
      diff.push(`ログ ${i + 1}行目: 記録「${record.log[i]!.text}」/ 再生「${engine.log[i]!.text}」`);
      break;
    }
  }
  if (chooser.consumed !== record.choices.length) {
    diff.push(`選択の消費数: 記録 ${record.choices.length} / 再生 ${chooser.consumed}`);
  }

  return {
    engine,
    result,
    matched: diff.length === 0,
    diff,
    consumed: chooser.consumed,
    total: record.choices.length,
  };
}

/** 一致しなければ例外にする（テストとCLI用） */
export function assertReplayMatches(r: ReplayResult): void {
  if (!r.matched) throw new ReplayError(`再生が記録と一致しない:\n  ${r.diff.join('\n  ')}`);
}

// ============================================================
// 表示
// ============================================================

/** 進行ログを「サイクル/フェイズ つき」で1行ずつ整形する */
export function formatLog(log: readonly LogEntry[], opts: { kindsOnly?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const e of log) {
    if (opts.kindsOnly && !e.kind) continue;
    const head = `C${e.cycle ?? '-'}/${(e.phase ?? '-').padEnd(10)}`;
    out.push(`${head} ${'  '.repeat(e.depth)}${e.text}`);
  }
  return out;
}

/** 選択の一覧を整形する（何手目に誰が何を選んだか） */
export function formatChoices(choices: readonly RecordedChoice[]): string[] {
  return choices.map((c, i) => {
    const head = `${String(i + 1).padStart(4)}. ${c.player}`;
    if (c.t === 'select' || c.t === 'order') {
      const what = c.labels.length > 0 ? c.labels.join(', ') : '(選ばない)';
      return `${head} ${c.t}(${c.kind}) ${c.prompt} → ${what}`;
    }
    return `${head} ${c.t} ${c.prompt} → ${c.value}`;
  });
}
