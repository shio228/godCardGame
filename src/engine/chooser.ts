/**
 * プレイヤーの選択。
 *
 * 方針（確定）: **async/await + Chooser**。
 * 効果の解決は `await` で選択を待つ。テストはスクリプト済みの Chooser、
 * UI は「クリックで解決される Promise」を返す実装を差し込む。
 *
 * インターフェースは 4 メソッドに絞ってある（select / number / confirm / order）。
 * 何を選ばせているかは `kind` で分岐する。UI はこれを見て見た目を切り替える。
 */
import type { PlayerId } from '../rules/types';
import { RuleError } from './errors';

export type ChoiceKind =
  | 'card'
  | 'stack'
  | 'token'
  | 'species'
  | 'entity'
  | 'player'
  | 'action'
  | 'mode'
  | 'weather'
  | 'pile'
  | 'position'
  | 'objective';

export interface Option<T> {
  value: T;
  /** 表示用ラベル（UI とテストのデバッグ用） */
  label: string;
}

export interface SelectRequest<T> {
  kind: ChoiceKind;
  player: PlayerId;
  prompt: string;
  options: Option<T>[];
  min: number;
  max: number;
}

export interface NumberRequest {
  player: PlayerId;
  prompt: string;
  min: number;
  max: number;
}

export interface ConfirmRequest {
  player: PlayerId;
  prompt: string;
}

export interface OrderRequest<T> {
  kind: ChoiceKind;
  player: PlayerId;
  prompt: string;
  options: Option<T>[];
}

export interface Chooser {
  /** min〜max 個を選ばせる。min===0 なら「選ばなくてよい」 */
  select<T>(req: SelectRequest<T>): Promise<T[]>;
  number(req: NumberRequest): Promise<number>;
  confirm(req: ConfirmRequest): Promise<boolean>;
  /** 並べ替え（デッキの上に置く順、誘発の処理順など） */
  order<T>(req: OrderRequest<T>): Promise<T[]>;
}

// ============================================================
// 既定の実装
// ============================================================

/**
 * 常に「先頭から必要数」を選び、任意効果はすべて実行する自動 Chooser。
 * ランダム対戦の土台とテストの既定値に使う。
 */
export class AutoChooser implements Chooser {
  constructor(private readonly acceptOptional = true) {}

  async select<T>(req: SelectRequest<T>): Promise<T[]> {
    const n = Math.min(Math.max(req.min, Math.min(req.max, req.options.length)), req.options.length);
    return req.options.slice(0, n).map((o) => o.value);
  }

  async number(req: NumberRequest): Promise<number> {
    return req.min;
  }

  async confirm(_req: ConfirmRequest): Promise<boolean> {
    return this.acceptOptional;
  }

  async order<T>(req: OrderRequest<T>): Promise<T[]> {
    return req.options.map((o) => o.value);
  }
}

/**
 * 一様ランダムに選ぶ Chooser。自動対戦（`tools/simulate.ts`）の対局者。
 *
 * `AutoChooser` は「常に先頭を選び、任意効果を必ず受ける」ので、
 * 手札を必ず出し切る・パスを一度もしない偏った打ち手になる。
 * バランスの数字を取るにはランダムに散らす必要があるためこちらを使う。
 * 乱数は自前の LCG で、シードを与えれば再現できる。
 */
export class RandomChooser implements Chooser {
  private seed: number;

  constructor(seed = 1) {
    this.seed = seed >>> 0;
  }

  /** [0, max) の整数 */
  private int(max: number): number {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return max <= 0 ? 0 : this.seed % max;
  }

  async select<T>(req: SelectRequest<T>): Promise<T[]> {
    const max = Math.min(req.max, req.options.length);
    const min = Math.min(req.min, max);
    const n = min + this.int(max - min + 1);
    const pool = [...req.options];
    const out: T[] = [];
    for (let k = 0; k < n && pool.length > 0; k++) {
      out.push(pool.splice(this.int(pool.length), 1)[0]!.value);
    }
    return out;
  }

  async number(req: NumberRequest): Promise<number> {
    const lo = req.min;
    const hi = Math.max(lo, req.max);
    return lo + this.int(hi - lo + 1);
  }

  async confirm(_req: ConfirmRequest): Promise<boolean> {
    return this.int(2) === 0;
  }

  async order<T>(req: OrderRequest<T>): Promise<T[]> {
    const pool = [...req.options];
    const out: T[] = [];
    while (pool.length > 0) out.push(pool.splice(this.int(pool.length), 1)[0]!.value);
    return out;
  }
}

/**
 * プレイヤーごとに別の打ち手を割り当てる。
 * AI同士の比較（貪欲 vs ランダム）と、将来の「人間 vs AI」の両方でここを通る。
 */
export class PerPlayerChooser implements Chooser {
  constructor(private readonly by: Record<PlayerId, Chooser>) {}

  select<T>(req: SelectRequest<T>): Promise<T[]> {
    return this.by[req.player].select(req);
  }

  number(req: NumberRequest): Promise<number> {
    return this.by[req.player].number(req);
  }

  confirm(req: ConfirmRequest): Promise<boolean> {
    return this.by[req.player].confirm(req);
  }

  order<T>(req: OrderRequest<T>): Promise<T[]> {
    return this.by[req.player].order(req);
  }
}

/** テスト用のスクリプト済み応答。1件ずつ消費し、尽きたら fallback に委譲する。 */
export type ScriptedAnswer =
  /** select: 選ぶ選択肢のインデックス配列 */
  | { select: number[] }
  /** select: ラベル一致で選ぶ */
  | { selectLabels: string[] }
  | { number: number }
  | { confirm: boolean }
  /** order: 並べ替え後のインデックス列 */
  | { order: number[] };

export class ScriptedChooser implements Chooser {
  private i = 0;
  readonly seen: string[] = [];

  constructor(
    private readonly answers: ScriptedAnswer[],
    private readonly fallback: Chooser = new AutoChooser(),
  ) {}

  private next(): ScriptedAnswer | undefined {
    return this.answers[this.i++];
  }

  async select<T>(req: SelectRequest<T>): Promise<T[]> {
    this.seen.push(`select(${req.kind}): ${req.prompt} [${req.options.map((o) => o.label).join(', ')}]`);
    const a = this.next();
    if (!a) return this.fallback.select(req);
    if ('select' in a) {
      return a.select.map((idx) => {
        const o = req.options[idx];
        if (!o) throw new RuleError(`ScriptedChooser: 選択肢 ${idx} が存在しない (${req.prompt})`);
        return o.value;
      });
    }
    if ('selectLabels' in a) {
      return a.selectLabels.map((label) => {
        const o = req.options.find((x) => x.label === label);
        if (!o) throw new RuleError(`ScriptedChooser: ラベル "${label}" が選択肢にない (${req.prompt})`);
        return o.value;
      });
    }
    throw new RuleError(`ScriptedChooser: select が期待されたが ${JSON.stringify(a)} が来た (${req.prompt})`);
  }

  async number(req: NumberRequest): Promise<number> {
    this.seen.push(`number: ${req.prompt}`);
    const a = this.next();
    if (!a) return this.fallback.number(req);
    if ('number' in a) return a.number;
    throw new RuleError(`ScriptedChooser: number が期待されたが ${JSON.stringify(a)} が来た`);
  }

  async confirm(req: ConfirmRequest): Promise<boolean> {
    this.seen.push(`confirm: ${req.prompt}`);
    const a = this.next();
    if (!a) return this.fallback.confirm(req);
    if ('confirm' in a) return a.confirm;
    throw new RuleError(`ScriptedChooser: confirm が期待されたが ${JSON.stringify(a)} が来た`);
  }

  async order<T>(req: OrderRequest<T>): Promise<T[]> {
    this.seen.push(`order(${req.kind}): ${req.prompt}`);
    const a = this.next();
    if (!a) return this.fallback.order(req);
    if ('order' in a) {
      return a.order.map((idx) => {
        const o = req.options[idx];
        if (!o) throw new RuleError(`ScriptedChooser: 選択肢 ${idx} が存在しない`);
        return o.value;
      });
    }
    throw new RuleError(`ScriptedChooser: order が期待されたが ${JSON.stringify(a)} が来た`);
  }
}
