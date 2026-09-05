/**
 * 記録した選択を再生し、**次の選択のところで止める**。
 *
 * サーバは常駐しないので、対戦の実体は「選択の列」だけにしてある。
 * エンジンの乱数は `GameState.rng`（シード付きLCG）だけで時刻も `Math.random` も使わないので、
 * `(セットアップ, シード, 選択の列)` が同じなら盤面は完全に再現できる。
 *
 * ## 止め方
 *
 * `runGame` には中断の口が無いが、**記録が尽きたら `Chooser` が例外を投げればよい**。
 * 呼び出しスタックが畳まれて `resumeGame` まで戻り、`engine.state` は
 * **その選択を求めた瞬間の盤面**のまま残る。これがそのままビューになる。
 *
 * ## AI の席
 *
 * 例外には**ワイヤ用の形（ラベルだけ）と、エンジン内部の元のリクエストの両方**を載せる。
 * AI に答えさせるときは元のリクエストをそのまま渡し、返ってきた値を番号に直して
 * 記録に足す。記録に残るので、次の再生で AI を動かし直す必要はない。
 */
import type { CardPool, PlayerId } from '../rules/types';
import type { Chooser, ConfirmRequest, NumberRequest, OrderRequest, SelectRequest } from '../engine/chooser';
import type { Engine } from '../engine/context';
import { EngineError } from '../engine/errors';
import { createEngine, runGame, startGame } from '../engine/flow';
import type { GameSetup, RecordedChoice } from '../engine/replay';
import { playerView, type PlayerView } from '../engine/view';
import type { PendingRequest } from './protocol';
import type { GameResultInfo } from './protocol';

/** サーバ側の再生では、1試合を通した累積のステップ上限を大きめに取る */
export const SERVER_BUDGET = 200000;

export class ResumeError extends EngineError {}

/** エンジン内部の生のリクエスト（AI に答えさせるときだけ使う） */
export type RawRequest =
  | { t: 'select'; req: SelectRequest<unknown> }
  | { t: 'number'; req: NumberRequest }
  | { t: 'confirm'; req: ConfirmRequest }
  | { t: 'order'; req: OrderRequest<unknown> };

/** 記録が尽きた ＝ ここで人（かAI）の入力が要る */
class NeedInput extends Error {
  constructor(
    readonly pending: PendingRequest,
    readonly raw: RawRequest,
  ) {
    super(`入力待ち: ${pending.prompt}`);
  }
}

function labelsOf(options: readonly { label: string }[]): string[] {
  return options.map((o) => o.label);
}

/**
 * 記録を読み上げ、尽きたら `NeedInput` を投げる Chooser。
 * 記録との突き合わせは `ReplayChooser` と同じ（種別・席・プロンプト・ラベル）。
 */
class ResumeChooser implements Chooser {
  private i = 0;

  constructor(private readonly choices: readonly RecordedChoice[]) {}

  get consumed(): number {
    return this.i;
  }

  private next<K extends RecordedChoice['t']>(
    t: K,
    player: PlayerId,
    prompt: string,
  ): Extract<RecordedChoice, { t: K }> | undefined {
    const c = this.choices[this.i];
    if (!c) return undefined;
    if (c.t !== t || c.player !== player || c.prompt !== prompt) {
      throw new ResumeError(
        `記録がずれている（${this.i + 1}手目）\n  記録: ${c.t} / ${c.player} / ${c.prompt}\n  再生: ${t} / ${player} / ${prompt}`,
      );
    }
    this.i++;
    return c as Extract<RecordedChoice, { t: K }>;
  }

  private stop(pending: Omit<PendingRequest, 'index'>, raw: RawRequest): never {
    throw new NeedInput({ index: this.i, ...pending }, raw);
  }

  async select<T>(req: SelectRequest<T>): Promise<T[]> {
    const rec = this.next('select', req.player, req.prompt);
    if (!rec) {
      this.stop(
        { t: 'select', player: req.player, kind: req.kind, prompt: req.prompt, options: labelsOf(req.options), min: req.min, max: req.max },
        { t: 'select', req: req as SelectRequest<unknown> },
      );
    }
    return pick(rec, req.options, this.i);
  }

  async number(req: NumberRequest): Promise<number> {
    const rec = this.next('number', req.player, req.prompt);
    if (!rec) {
      this.stop(
        { t: 'number', player: req.player, prompt: req.prompt, min: req.min, max: req.max },
        { t: 'number', req },
      );
    }
    return rec.value;
  }

  async confirm(req: ConfirmRequest): Promise<boolean> {
    const rec = this.next('confirm', req.player, req.prompt);
    if (!rec) this.stop({ t: 'confirm', player: req.player, prompt: req.prompt }, { t: 'confirm', req });
    return rec.value;
  }

  async order<T>(req: OrderRequest<T>): Promise<T[]> {
    const rec = this.next('order', req.player, req.prompt);
    if (!rec) {
      this.stop(
        { t: 'order', player: req.player, kind: req.kind, prompt: req.prompt, options: labelsOf(req.options) },
        { t: 'order', req: req as OrderRequest<unknown> },
      );
    }
    return pick(rec, req.options, this.i);
  }
}

function pick<T>(
  rec: { picked: number[]; labels: string[] },
  options: readonly { value: T; label: string }[],
  at: number,
): T[] {
  return rec.picked.map((idx, k) => {
    const o = options[idx];
    if (!o) throw new ResumeError(`${at}手目: 選択肢 ${idx} が存在しない（選択肢は${options.length}件）`);
    if (o.label !== rec.labels[k]) {
      throw new ResumeError(`${at}手目でずれた\n  記録: ${rec.labels[k]}\n  再生: ${o.label}`);
    }
    return o.value;
  });
}

// ============================================================

export interface ResumeOptions {
  names?: Record<PlayerId, string>;
  /** ビューに載せるログの開始位置（席ごと） */
  logFrom?: Partial<Record<PlayerId, number>>;
}

export interface ResumeResult {
  /** 止まった時点のエンジン。AI に答えさせるときはこれを使う */
  engine: Engine;
  views: Record<PlayerId, PlayerView>;
  /** 次に要る選択（試合が終わっていれば無い） */
  pending?: PendingRequest;
  /** AI に答えさせるための生のリクエスト */
  raw?: RawRequest;
  result?: GameResultInfo;
  /** ルール上あり得ない状態などで落ちた場合 */
  error?: string;
}

/**
 * 記録を再生し、次の選択のところで止めてビューを作る。
 * **エンジンを回すのはここだけ。** ポーリングの経路からは呼ばない。
 */
export async function resumeGame(
  pool: CardPool,
  setup: GameSetup,
  choices: readonly RecordedChoice[],
  opts: ResumeOptions = {},
): Promise<ResumeResult> {
  const chooser = new ResumeChooser(choices);
  const engine = createEngine({
    pool,
    p1God: setup.p1God,
    p2God: setup.p2God,
    seed: setup.seed,
    chooser,
    budget: setup.budget ?? SERVER_BUDGET,
    ...(setup.life !== undefined ? { life: setup.life } : {}),
    ...(setup.weather !== undefined ? { weather: setup.weather } : {}),
    ...(setup.first !== undefined ? { first: setup.first } : {}),
  });

  let pending: PendingRequest | undefined;
  let raw: RawRequest | undefined;
  let error: string | undefined;

  try {
    await startGame(engine, {
      P1: setup.decks.P1,
      P2: setup.decks.P2,
      ...(setup.objectiveMin !== undefined ? { objectiveMin: setup.objectiveMin } : {}),
    });
    await runGame(engine, setup.maxCycles ?? 20);
  } catch (e) {
    if (e instanceof NeedInput) {
      pending = e.pending;
      raw = e.raw;
    } else {
      error = `${(e as Error).name}: ${(e as Error).message}`;
    }
  }

  const views = {
    P1: await view(engine, 'P1', opts),
    P2: await view(engine, 'P2', opts),
  };

  const out: ResumeResult = { engine, views };
  if (pending) out.pending = pending;
  if (raw) out.raw = raw;
  if (error !== undefined) out.error = error;
  if (engine.state.winner !== undefined) {
    out.result = {
      winner: engine.state.winner,
      cycles: engine.state.cycle,
      ...(engine.state.winReason !== undefined ? { reason: engine.state.winReason } : {}),
    };
  }
  return out;
}

function view(engine: Engine, seat: PlayerId, opts: ResumeOptions): Promise<PlayerView> {
  const from = opts.logFrom?.[seat];
  return playerView(engine, seat, {
    ...(opts.names ? { names: opts.names } : {}),
    ...(from !== undefined ? { logFrom: from } : {}),
  });
}

/**
 * 生のリクエストに `Chooser` で答えさせ、**記録の形**に直す。
 * AI の席で使う（人の応答は番号で届くので `answerToChoice` を使う）。
 */
export async function askChooser(chooser: Chooser, raw: RawRequest): Promise<RecordedChoice> {
  if (raw.t === 'number') {
    return { t: 'number', player: raw.req.player, prompt: raw.req.prompt, value: await chooser.number(raw.req) };
  }
  if (raw.t === 'confirm') {
    return { t: 'confirm', player: raw.req.player, prompt: raw.req.prompt, value: await chooser.confirm(raw.req) };
  }
  const values = raw.t === 'select' ? await chooser.select(raw.req) : await chooser.order(raw.req);
  const req = raw.req;
  const picked = indicesOf(req.options, values);
  return {
    t: raw.t,
    player: req.player,
    kind: req.kind,
    prompt: req.prompt,
    picked,
    labels: picked.map((i) => req.options[i]!.label),
  };
}

/** 値の配列を選択肢の番号に直す（同じ値が複数あっても番号が重ならない） */
function indicesOf<T>(options: readonly { value: T; label: string }[], values: readonly T[]): number[] {
  const used = new Set<number>();
  return values.map((v) => {
    const i = options.findIndex((o, k) => !used.has(k) && o.value === v);
    if (i < 0) throw new ResumeError('選択肢に無い値が返された');
    used.add(i);
    return i;
  });
}

/**
 * クライアントから届いた答え（番号 / 数 / 真偽）を**検証して**記録の形にする。
 * ここを通らない入力は記録に入らない。
 */
export function answerToChoice(pending: PendingRequest, answer: unknown): RecordedChoice {
  if (pending.t === 'confirm') {
    if (typeof answer !== 'boolean') throw new ResumeError('はい/いいえで答える選択です');
    return { t: 'confirm', player: pending.player, prompt: pending.prompt, value: answer };
  }
  if (pending.t === 'number') {
    const min = pending.min ?? 0;
    const max = pending.max ?? 0;
    if (typeof answer !== 'number' || !Number.isInteger(answer) || answer < min || answer > max) {
      throw new ResumeError(`${min}〜${max} の整数で答える選択です`);
    }
    return { t: 'number', player: pending.player, prompt: pending.prompt, value: answer };
  }

  const options = pending.options ?? [];
  if (!Array.isArray(answer) || answer.some((x) => !Number.isInteger(x))) {
    throw new ResumeError('選択肢の番号（配列）で答える選択です');
  }
  const picked = answer as number[];
  if (new Set(picked).size !== picked.length) throw new ResumeError('同じ選択肢は選べません');
  for (const i of picked) {
    if (i < 0 || i >= options.length) throw new ResumeError(`選択肢 ${i} は存在しません`);
  }
  if (pending.t === 'order') {
    if (picked.length !== options.length) throw new ResumeError('すべての選択肢を1回ずつ並べてください');
  } else {
    const min = pending.min ?? 0;
    const max = pending.max ?? options.length;
    if (picked.length < min || picked.length > max) {
      throw new ResumeError(`${min}〜${max} 件を選んでください`);
    }
  }
  return {
    t: pending.t,
    player: pending.player,
    ...(pending.kind !== undefined ? { kind: pending.kind } : {}),
    prompt: pending.prompt,
    picked,
    labels: picked.map((i) => options[i]!),
  } as RecordedChoice;
}
