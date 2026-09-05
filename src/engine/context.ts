/**
 * 解決コンテキスト。
 *
 * 束縛は 3 スケール（設計書）:
 *   let / bind   → Scope（ひとつの効果ツリーの中だけ）
 *   暗黙束縛     → Scope（誘発の実行中だけ = その誘発用に作った Scope）
 *   snapshot     → StackItem.snapshots（その項目が存在する間ずっと）
 *
 * `{t:'var', name}` は Scope を親方向にたどり、見つからなければ
 * ctx.item.snapshots を見る。この 2 段構えで 3 スケールを賄う。
 */
import type { DamageTag, Effect, Limit, PlayerId, Value } from '../rules/types';
import type { Chooser } from './chooser';
import { BindingError } from './errors';
import { PoolIndex } from './pool';
import type { Weather } from '../rules/types';
import type { Bound, Entity, GameEvent, GameState, Phase, StackItem } from './state';

// ============================================================
// 束縛スコープ
// ============================================================

export class Scope {
  private readonly map = new Map<string, Bound>();

  constructor(readonly parent?: Scope) {}

  set(name: string, value: Bound): void {
    this.map.set(name, value);
  }

  get(name: string): Bound | undefined {
    return this.map.get(name) ?? this.parent?.get(name);
  }

  child(): Scope {
    return new Scope(this);
  }
}

// ============================================================
// handler レジストリ（DSL に載せないものの逃げ道）
// ============================================================

export type HandlerParams = Record<string, Value | string | boolean>;

export interface HandlerRegistry {
  effect: Map<string, (ctx: Ctx, params: HandlerParams) => Promise<void> | void>;
  condition: Map<string, (ctx: Ctx) => boolean>;
  /** ContinuousMod の handler。ダメージ計算などから参照される */
  mod: Map<string, unknown>;
}

export function createHandlerRegistry(): HandlerRegistry {
  return { effect: new Map(), condition: new Map(), mod: new Map() };
}

// ============================================================
// エンジン（1ゲーム分の可変環境）
// ============================================================

/**
 * ログ行の種類。リプレイのログを読むとき・絞り込むときの目印。
 * ここに無い（`kind` を持たない）行は効果の内部から出た細かい記録。
 */
export type LogKind =
  | 'phase'    // フェイズの開始
  | 'play'     // カードのプレイ / 代替プレイ
  | 'pass'     // パス
  | 'draw'     // ドロー
  | 'reveal'   // 勝利条件の公開
  | 'resolve'  // スタック項目の解決
  | 'trigger'  // 誘発の実行
  | 'weather'  // 天候が起こした処理
  | 'win';     // 勝敗の確定

/**
 * 行動ログ1行ぶんの盤面の写し。
 * リプレイの表示（ライフの推移・スタックの高さ・そのときの天候）に使う軽量な記録で、
 * ルールの判定には一切使わない。数値6つぶんなので記録が重くならない。
 */
export interface LogSnapshot {
  /** [P1, P2] */
  life: [number, number];
  hand: [number, number];
  /** スタック上の項目数（全スタックの合計） */
  stack: number;
  weather: Weather;
  apocalypse: boolean;
}

export interface LogEntry {
  depth: number;
  text: string;
  /** 記録した時点のサイクルとフェイズ（リプレイのログを時系列で読むため） */
  cycle?: number;
  phase?: Phase;
  kind?: LogKind;
  player?: PlayerId;
  /** 行動ログ（`kind` を持つ行）にだけ付く盤面の写し */
  snap?: LogSnapshot;
}

/** 誘発待ちの1件 */
export interface PendingTrigger {
  /** 誘発の持ち主（「あなた」が誰を指すか） */
  controller: PlayerId;
  /** 誘発の発生源（「このカード」） */
  item?: StackItem;
  effect: Effect;
  optional?: boolean;
  /** 暗黙束縛 */
  bindings: Record<string, Bound>;
  /** ログ・順序決定用の表示名 */
  label: string;
  /** limit の消費キーと定義 */
  limitKey?: string;
  limit?: Limit;
}

export interface Engine {
  state: GameState;
  pool: PoolIndex;
  chooser: Chooser;
  handlers: HandlerRegistry;
  /** 発生済みだがまだ処理していない誘発 */
  pending: PendingTrigger[];
  log: LogEntry[];
  /** 再帰の深さ。ログのインデントに使う */
  depth: number;
  /** 実行を許す効果ノード数の上限（無限ループ検出） */
  budget: number;
  /** 消費済みステップ数 */
  steps: number;
  /**
   * いま解決中のスタック項目の uid。
   * 「スタック上のカードを全て解決する」（スプリットディメンション）が
   * 自分自身を巻き込んで無限に再帰するのを防ぐ。
   */
  resolving: Set<string>;
  /**
   * `untargetable` の判定中かどうか（再帰の深さ）。
   * **エンジンごとに持つ。** モジュール変数にすると、1つのプロセスで複数の対戦を
   * 同時に進めたとき（サーバ）に、`await` を挟んだ隙に別の対戦が割り込んで
   * 「対象に取れる」を無条件に返してしまう。
   */
  targetCheckDepth: number;
}

// ============================================================
// 効果1つ分のコンテキスト
// ============================================================

export interface Ctx {
  engine: Engine;
  /** 「あなた」 */
  self: PlayerId;
  /** 「このカード」。スタック項目に紐づかない効果（神のパッシブ等）では undefined */
  item?: StackItem;
  /** この効果が属するスタック。StackSel の既定の探索範囲 */
  stackId?: string;
  vars: Scope;
  /** 「対象」。プレイ時ではなく解決時に確定させる（確定事項） */
  targets?: Entity[];
  /** NamedAction 由来のダメージタグ。damage の tags に合流する */
  actionTags?: DamageTag[];
}

export function state(ctx: Ctx): GameState {
  return ctx.engine.state;
}

export function pool(ctx: Ctx): PoolIndex {
  return ctx.engine.pool;
}

/** 子スコープを持つ ctx を作る（let / bind / forEach 用） */
export function childScope(ctx: Ctx): Ctx {
  return { ...ctx, vars: ctx.vars.child() };
}

export function withBinding(ctx: Ctx, name: string, value: Bound): Ctx {
  const c = childScope(ctx);
  c.vars.set(name, value);
  return c;
}

/**
 * `{t:'var', name}` の解決。Scope → snapshot の順に探す。
 * どちらにもなければ記述ミスなので例外を投げる（黙って 0 にしない）。
 */
export function lookup(ctx: Ctx, name: string): Bound {
  const v = ctx.vars.get(name) ?? ctx.item?.snapshots[name];
  if (!v) throw new BindingError(`束縛 "${name}" が見つからない`);
  return v;
}

export function lookupOpt(ctx: Ctx, name: string): Bound | undefined {
  return ctx.vars.get(name) ?? ctx.item?.snapshots[name];
}

export function logLine(ctx: Ctx, text: string): void {
  ctx.engine.log.push({
    depth: ctx.engine.depth,
    text,
    cycle: ctx.engine.state.cycle,
    phase: ctx.engine.state.phase,
  });
}

/**
 * 行動として記録するログ。`logLine` との違いは `kind` が付くことだけで、
 * 「何が起きたか」を後から機械的に拾えるようにするためにある。
 */
export function logAction(engine: Engine, kind: LogKind, text: string, player?: PlayerId): void {
  engine.log.push({
    depth: engine.depth,
    text,
    kind,
    cycle: engine.state.cycle,
    phase: engine.state.phase,
    snap: snapshotOf(engine),
    ...(player ? { player } : {}),
  });
}

function snapshotOf(engine: Engine): LogSnapshot {
  const s = engine.state;
  return {
    life: [s.players.P1.life, s.players.P2.life],
    hand: [s.players.P1.zones.hand[0]?.length ?? 0, s.players.P2.zones.hand[0]?.length ?? 0],
    stack: s.stacks.reduce((a, st) => a + st.items.length, 0),
    weather: s.weather,
    apocalypse: s.apocalypse,
  };
}

/** 暗黙束縛を積んだ ctx を作る（誘発の実行直前にエンジンが呼ぶ） */
export function withBindings(ctx: Ctx, bindings: Record<string, Bound>): Ctx {
  const c = childScope(ctx);
  for (const [k, v] of Object.entries(bindings)) c.vars.set(k, v);
  return c;
}

export function eventBindings(ev: GameEvent): Record<string, Bound> {
  return ev.bindings ?? {};
}
