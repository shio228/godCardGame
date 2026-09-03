/**
 * 特殊勝利条件の「達成度」。
 *
 * 勝利条件は `ObjectiveDef.cond` という**データ**なので、
 * エンジンが持っている `evalValue` / `evalCondition` をそのまま使って
 * 「いまどこまで進んでいるか」を数字にできる。AI 側に勝利条件の知識を写さなくてよい。
 *
 * 使い道は2つ:
 *   - 目的志向AI（`ai.ts`）が「どの手がいちばん条件に近づくか」を測る物差し
 *   - 自動対戦の集計で「達成できなかった条件は、どこまで行っていたのか」を出す
 *     （達成不能なのか、AIが踏めていないだけなのかの切り分け）
 *
 * ## 測れないもの
 *
 * `cond` が**盤面ではなくイベントの暗黙束縛**を見る条件は測れない。
 * 一撃必殺（`{t:'var', name:'amount'} >= 8` ＝ 直前に通ったダメージ）がこれで、
 * 盤面から評価しようとすると `BindingError` になる。
 * この関数は例外を握りつぶして `undefined`（測れない）を返す — **勝敗を左右しない
 * 計測用の関数**なので、ここだけは「黙って0にしない」の対象外にしている。
 * 代わりに「測れない」ことが呼び出し側に伝わる形（`undefined`）にした。
 */
import type { Condition, ObjectiveDef, PlayerId } from '../rules/types';
import { evalCondition } from './condition';
import type { Ctx, Engine } from './context';
import { hiddenObjectives, objectiveCtx, revealedObjectives } from './objectives';
import { evalValue } from './value';

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/**
 * 条件の達成度（0〜1）。1 なら成立している。測れない条件は `undefined`。
 *
 * - `cmp` … 「あと何点で届くか」を比で出す。`==` は差の小ささを見る
 * - `and` … 子の平均（「5つのうち3つそろった」が 0.6 になる。min だと最悪の1つが動くまで
 *            進捗が0のままで、AIの手掛かりにならない）
 * - `or`  … 子の最大
 * - それ以外（天候・存在判定など） … 成立していれば1、していなければ0
 */
export async function conditionProgress(cond: Condition, ctx: Ctx): Promise<number | undefined> {
  switch (cond.t) {
    case 'cmp': {
      let a: number;
      let b: number;
      try {
        a = await evalValue(cond.a, ctx);
        b = await evalValue(cond.b, ctx);
      } catch {
        return undefined; // 盤面からは評価できない（イベントの暗黙束縛を見ている）
      }
      switch (cond.op) {
        case '>=':
          return b <= 0 ? (a >= b ? 1 : 0) : clamp01(a / b);
        case '>':
          return b <= 0 ? (a > b ? 1 : 0) : clamp01(a / (b + 1));
        case '<=':
          return a <= b ? 1 : clamp01(b / a);
        case '<':
          return a < b ? 1 : clamp01(b / a);
        case '==': {
          if (a === b) return 1;
          const scale = Math.max(Math.abs(b), 1);
          return clamp01(1 - Math.abs(a - b) / scale);
        }
        case '!=':
          return a !== b ? 1 : 0;
        default:
          return undefined;
      }
    }
    case 'and': {
      const ps: number[] = [];
      for (const c of cond.of) {
        const p = await conditionProgress(c, ctx);
        if (p !== undefined) ps.push(p);
      }
      return ps.length === 0 ? undefined : ps.reduce((x, y) => x + y, 0) / ps.length;
    }
    case 'or': {
      const ps: number[] = [];
      for (const c of cond.of) {
        const p = await conditionProgress(c, ctx);
        if (p !== undefined) ps.push(p);
      }
      return ps.length === 0 ? undefined : Math.max(...ps);
    }
    case 'not': {
      const p = await conditionProgress(cond.of, ctx);
      return p === undefined ? undefined : 1 - p;
    }
    default:
      try {
        return (await evalCondition(cond, ctx)) ? 1 : 0;
      } catch {
        return undefined;
      }
  }
}

/** 条件を人が読める形にする（ダッシュボードとログ用） */
export async function describeCondition(cond: Condition, ctx: Ctx): Promise<string> {
  if (cond.t === 'cmp') {
    try {
      const a = await evalValue(cond.a, ctx);
      const b = await evalValue(cond.b, ctx);
      return `${a} ${cond.op} ${b}`;
    } catch {
      return '盤面からは測れない';
    }
  }
  if (cond.t === 'and') {
    const parts: string[] = [];
    for (const c of cond.of) parts.push(String((await conditionProgress(c, ctx)) ?? '-'));
    const done = parts.filter((p) => p === '1').length;
    return `${done} / ${cond.of.length} 達成`;
  }
  const p = await conditionProgress(cond, ctx);
  return p === undefined ? '測れない' : p >= 1 ? '成立' : '未成立';
}

export interface ObjectiveProgress {
  objective: ObjectiveDef;
  /** 公開済みか（公開されている条件だけが有効） */
  revealed: boolean;
  /** 0〜1。測れない条件は undefined */
  progress?: number;
  detail: string;
}

/**
 * そのプレイヤーの勝利条件の達成度を返す。
 *
 * **相手の分は返さない。** 伏せてある条件はコードからは見えてしまうが、
 * AIに渡すと伏せ札を読むことになり、自動対戦の数字が歪む。
 */
export async function objectiveProgress(engine: Engine, player: PlayerId): Promise<ObjectiveProgress[]> {
  const ctx = objectiveCtx(engine, player);
  const out: ObjectiveProgress[] = [];
  const seen: { def: ObjectiveDef; revealed: boolean }[] = [
    ...revealedObjectives(engine, player).map((def) => ({ def, revealed: true })),
    ...hiddenObjectives(engine, player).map((def) => ({ def, revealed: false })),
  ];
  for (const { def, revealed } of seen) {
    if (!def.cond) {
      out.push({ objective: def, revealed, detail: '条件なし' });
      continue;
    }
    const progress = await conditionProgress(def.cond, ctx);
    out.push({
      objective: def,
      revealed,
      ...(progress !== undefined ? { progress } : {}),
      detail: await describeCondition(def.cond, ctx),
    });
  }
  return out;
}

/**
 * AIの評価に使う1つの数値。公開済みの条件を重く、伏せてある条件を軽く見る。
 * 伏せてある分も少し見るのは、次のサイクルで公開する条件に向けて動けるようにするため。
 */
export async function objectiveScore(
  engine: Engine,
  player: PlayerId,
  hiddenWeight = 0.5,
): Promise<number> {
  let sum = 0;
  for (const p of await objectiveProgress(engine, player)) {
    if (p.progress === undefined) continue;
    sum += p.progress * (p.revealed ? 1 : hiddenWeight);
  }
  return sum;
}
