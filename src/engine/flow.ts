/**
 * ゲーム進行の最小限の骨格。
 * 解決エンジンを外から動かすための入口をまとめている。
 * （ターン進行の細部 — 順番確定フェイズ・パスの扱い — はまだここには無い）
 */
import type { CardPool, God, PlayerId } from '../rules/types';
import { AutoChooser, type Chooser } from './chooser';
import { Scope, createHandlerRegistry, type Ctx, type Engine, type HandlerRegistry } from './context';
import { evalCondition } from './condition';
import { resolveStackItem } from './effects';
import { drainTriggers, emit, consumeLimit, limitAvailable } from './events';
import { RuleError } from './errors';
import { PoolIndex } from './pool';
import { revealPhase } from './objectives';
import { resolveEntities } from './select';
import {
  createState,
  nextUid,
  stackOf,
  type CardInstance,
  type CreateStateOptions,
  type GameState,
  type StackItem,
} from './state';

export interface CreateEngineOptions extends CreateStateOptions {
  pool: CardPool;
  chooser?: Chooser;
  handlers?: HandlerRegistry;
  /** 無限ループ検出のためのステップ上限 */
  budget?: number;
}

export function createEngine(opts: CreateEngineOptions): Engine {
  return {
    state: createState(opts),
    pool: new PoolIndex(opts.pool),
    chooser: opts.chooser ?? new AutoChooser(),
    handlers: opts.handlers ?? createHandlerRegistry(),
    pending: [],
    log: [],
    depth: 0,
    budget: opts.budget ?? 10000,
    steps: 0,
    resolving: new Set<string>(),
  };
}

/** スタックに紐づかない、プレイヤー視点の ctx */
export function topCtx(engine: Engine, self: PlayerId): Ctx {
  return { engine, self, vars: new Scope() };
}

// ============================================================
// セットアップ補助
// ============================================================

export function makeCard(engine: Engine, defId: string, owner: PlayerId): CardInstance {
  return { uid: nextUid(engine.state, 'C'), defId, owner };
}

/** デッキの一番上に置く（テストのセットアップ用） */
export function putOnDeck(engine: Engine, owner: PlayerId, defIds: string[]): CardInstance[] {
  const out = defIds.map((id) => makeCard(engine, id, owner));
  engine.state.players[owner].zones.deck[0]!.push(...out);
  return out;
}

export function putInHand(engine: Engine, owner: PlayerId, defIds: string[]): CardInstance[] {
  const out = defIds.map((id) => makeCard(engine, id, owner));
  engine.state.players[owner].zones.hand[0]!.push(...out);
  return out;
}

// ============================================================
// プレイ
// ============================================================

/**
 * 手札のカードをスタックに乗せる。
 * PlayRule（条件 / 追加コスト / 回数 / タイミング / 位置）をここで検査する。
 */
export async function play(engine: Engine, player: PlayerId, card: CardInstance): Promise<StackItem> {
  const def = engine.pool.card(card.defId);
  const s = engine.state;
  const ctx = topCtx(engine, player);
  const rule = def.play;

  if (rule?.timing) {
    const now = s.phase === 'order' ? 'orderPhase' : 'stackPhase';
    if (!rule.timing.includes(now)) throw new RuleError(`${def.name} はこのフェイズにはプレイできない`);
  }
  if (rule?.cond && !(await evalCondition(rule.cond, ctx))) {
    throw new RuleError(`${def.name} のプレイ条件を満たしていない`);
  }
  const limitKey = `play:${player}:${def.id}`;
  if (rule?.limit && !limitAvailable(engine, limitKey, rule.limit)) {
    throw new RuleError(`${def.name} はこれ以上プレイできない`);
  }
  if (rule?.cost) {
    const { resolve } = await import('./effects');
    await resolve(rule.cost, ctx);
  }
  if (rule?.limit) consumeLimit(engine, limitKey, rule.limit);

  // 手札から取り除いてスタックへ
  const hand = s.players[player].zones.hand[0]!;
  const i = hand.findIndex((c) => c.uid === card.uid);
  if (i >= 0) hand.splice(i, 1);

  const st = stackOf(s, undefined);
  const item: StackItem = {
    uid: nextUid(s, 'IT'),
    kind: 'card',
    controller: player,
    stackId: st.id,
    card,
    counters: {},
    snapshots: {},
    immovable: def.immovable === true,
  };
  st.items.push(item);

  const itemCtx: Ctx = { engine, self: player, item, stackId: st.id, vars: new Scope() };

  // 詠唱カウンターの初期値（キーワード chant を持つカードは1つ乗った状態で始まる）
  if (def.keywords?.includes('chant')) item.counters.chant = 1;

  await emit(itemCtx, { kind: 'played', itemUid: item.uid, player });
  await emit(itemCtx, { kind: 'placedOnStack', itemUid: item.uid, player });

  const { resolve } = await import('./effects');
  for (const ab of def.abilities) {
    if (ab.kind === 'onPlay') await resolve(ab.effect, itemCtx);
  }

  await drainTriggers(engine);
  return item;
}

// ============================================================
// フェイズ
// ============================================================

/** ⑤解決フェイズ。上から1つずつ解決する */
export async function resolvePhase(engine: Engine): Promise<void> {
  const s = engine.state;
  s.phase = 'resolve';
  await emit(topCtx(engine, s.first), { kind: 'resolveStart' });
  await drainTriggers(engine);

  let guard = 0;
  for (;;) {
    if (++guard > 500) throw new RuleError('解決フェイズが終わらない');
    if (s.winner) return;
    const st = stackOf(s, undefined);
    const top = st.items[st.items.length - 1];
    if (!top) break;
    await resolveStackItem(topCtx(engine, top.controller), top, false);
    await drainTriggers(engine);
  }
}

/**
 * ①サイクル開始。
 *
 * 公開特殊勝利条件のオープンが先。そこで先攻後攻が決まり、
 * cycleStart の誘発順（先攻 → 後攻）がそれに従うため、順番を入れ替えられない。
 */
export async function startCycle(engine: Engine): Promise<void> {
  const s = engine.state;
  s.cycle++;
  s.turn++;
  s.phase = 'cycleStart';
  await revealPhase(engine);
  await drainTriggers(engine);
  if (s.winner) return;
  await emit(topCtx(engine, s.first), { kind: 'cycleStart' });
  await drainTriggers(engine);
}

/** ⑥終了フェイズ。期限切れの状態と継続的効果を落とす */
export async function endTurn(engine: Engine): Promise<void> {
  const s = engine.state;
  s.phase = 'end';
  await emit(topCtx(engine, s.first), { kind: 'turnEnd' });
  await drainTriggers(engine);

  for (const pid of ['P1', 'P2'] as PlayerId[]) {
    const p = s.players[pid];
    const keep = p.statusGrants.filter((g) => g.duration !== 'thisTurn');
    for (const g of p.statusGrants) {
      if (g.duration === 'thisTurn') p.status[g.kind] = Math.max(0, p.status[g.kind] - g.amount);
    }
    p.statusGrants = keep;
    // 回避・シールドはターン終了時に必ず0に戻る
    p.status.evasion = 0;
    p.status.shield = 0;
    p.statusGrants = p.statusGrants.filter((g) => g.kind !== 'evasion' && g.kind !== 'shield');
  }

  s.continuous = s.continuous.filter((c) => c.duration !== 'thisTurn');
  s.grantedTriggers = s.grantedTriggers.filter((c) => c.duration !== 'thisTurn');
}

export async function endCycle(engine: Engine): Promise<void> {
  const s = engine.state;
  s.continuous = s.continuous.filter((c) => c.duration !== 'thisCycle' && c.duration !== 'thisTurn');
  s.grantedTriggers = s.grantedTriggers.filter((c) => c.duration !== 'thisCycle' && c.duration !== 'thisTurn');
  // 2サイクル終了時に書き換え不能な「終末」が発生する
  if (s.cycle >= 2) s.apocalypse = true;
}

export { resolveEntities };
export type { GameState, God };
