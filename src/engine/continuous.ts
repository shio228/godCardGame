/**
 * 継続的効果（ContinuousMod）の収集。
 *
 * 「常在」は実装上 continuous / triggered / activated に3分解される（設計書 §4）。
 * ここは continuous の側だけを扱う。発生源は4か所:
 *   ① 神のパッシブ（GodDef.passives, active:'always'）
 *   ② スタック上のカード / NamedAction（active:'onStack'）
 *   ③ 場のトークンとミニオン（active:'inField'）
 *   ④ grantContinuous で付与されたもの（GameState.continuous）
 *   ⑤ 公開済みの特殊勝利条件のパッシブ（ObjectiveDef.passive）
 *      — 「パッシブ能力が公開されている限りプレイヤーはその効果を持つ」（企画書）
 *
 * 置換効果もここに含まれる。**その操作を実行する経路が必ずこの層を通る**ことが
 * 設計の肝で、直接 life を引く / hand.push する場所をエンジン内に作らない。
 */
import type { Ability, ContinuousMod, EventKind, PlayerId } from '../rules/types';
import { Scope, type Ctx, type Engine } from './context';
import { evalCondition } from './condition';
import { NotImplementedError } from './errors';
// select.ts とは循環参照になるが、どちらも関数宣言のみを export しているため
// ESM の巻き上げで解決される。
import { resolvePlayers, resolveSpecies, resolveStack } from './select';
import { eachRevealedObjective } from './objectives';
import { opponentOf, type Bound, type CardInstance, type Entity, type GameState, type StackItem } from './state';

/** 置換の判定に必要なイベントの最小情報（`EmitSpec` の部分集合） */
export interface ReplaceableEvent {
  kind: EventKind;
  player?: PlayerId;
  itemUid?: string;
}

export interface ActiveMod {
  mod: ContinuousMod;
  /** 「あなた」が誰を指すか */
  controller: PlayerId;
  /** 発生源のスタック項目（sourceFilter / whileOnStack 用） */
  item?: StackItem;
  /** 発生源が手札のカードなら、そのカード（`active:'inHand'`） */
  card?: CardInstance;
  /** ログ用 */
  origin: string;
  /** grantContinuous 由来なら、その実体（onceOnly の消費に使う） */
  instanceId?: string;
  /** 付与時に写し取った発生源の snapshot（発生源が消えた後も参照できるようにする） */
  snapshots?: Record<string, Bound>;
}

/** そのモッドを評価するための ctx を作る */
export function modCtx(engine: Engine, am: ActiveMod): Ctx {
  const ctx: Ctx = {
    engine,
    self: am.controller,
    vars: new Scope(),
  };
  if (am.item) {
    ctx.item = am.item;
    ctx.stackId = am.item.stackId;
  }
  // 付与時に写し取った snapshot（発生源がスタックから降りた後も参照できる）
  if (am.snapshots) for (const [k, v] of Object.entries(am.snapshots)) ctx.vars.set(k, v);
  return ctx;
}

function abilityMods(
  abilities: Ability[],
  where: 'always' | 'onStack' | 'inField' | 'inHand',
  controller: PlayerId,
  origin: string,
  source?: { item?: StackItem; card?: CardInstance },
): ActiveMod[] {
  const out: ActiveMod[] = [];
  for (const ab of abilities) {
    if (ab.kind !== 'continuous') continue;
    if (ab.active !== where && ab.active !== 'always') continue;
    const am: ActiveMod = { mod: ab.mod, controller, origin };
    if (source?.item) am.item = source.item;
    if (source?.card) am.card = source.card;
    out.push(am);
  }
  return out;
}

/** 現在有効な継続的効果をすべて集める（条件判定はまだしない） */
export function gatherMods(engine: Engine): ActiveMod[] {
  const s = engine.state;
  const out: ActiveMod[] = [];

  // ① 神のパッシブ
  for (const pid of ['P1', 'P2'] as PlayerId[]) {
    const god = engine.pool.god(s.players[pid].god);
    if (god) out.push(...abilityMods(god.passives, 'always', pid, `神:${god.name}`));
  }

  // ② スタック上のカード / NamedAction
  for (const st of s.stacks) {
    for (const it of st.items) {
      if (it.kind === 'card' && it.card) {
        const def = engine.pool.card(it.card.defId);
        out.push(...abilityMods(def.abilities, 'onStack', it.controller, `カード:${def.name}`, { item: it }));
      }
    }
  }

  // ⑥ 手札のカード（`active:'inHand'`）。スカイエンハンスの
  //    「このカードを瞬発を持つかのようにプレイしてもよい」がここから出る
  for (const pid of ['P1', 'P2'] as PlayerId[]) {
    for (const c of s.players[pid].zones.hand[0] ?? []) {
      const def = engine.pool.card(c.defId);
      out.push(...abilityMods(def.abilities, 'inHand', pid, `手札:${def.name}`, { card: c }));
    }
  }

  // ③ 場のトークン / ミニオン
  for (const pid of ['P1', 'P2'] as PlayerId[]) {
    for (const tk of s.players[pid].tokens) {
      if (!tk.equipped) continue;
      const def = engine.pool.token(tk.defId);
      out.push(...abilityMods(def.abilities, 'inField', pid, `装備:${def.name}`));
    }
    for (const [sp, n] of Object.entries(s.players[pid].minions)) {
      if (n <= 0) continue;
      const def = engine.pool.minion(sp);
      if (def) out.push(...abilityMods(def.abilities, 'inField', pid, `ミニオン:${def.name}`));
    }
  }

  // ⑤ 公開済みの特殊勝利条件のパッシブ（公開されている間だけ働く）
  for (const { objective, controller } of eachRevealedObjective(engine)) {
    if (!objective.passive) continue;
    out.push({ mod: objective.passive, controller, origin: `勝利条件:${objective.name}` });
  }

  // ④ 付与されたもの
  for (const inst of s.continuous) {
    if (inst.onceOnly && inst.used) continue;
    if (!instanceAlive(s, inst.duration, inst.sourceUid)) continue;
    const am: ActiveMod = {
      mod: inst.mod,
      controller: inst.controller,
      origin: `付与:${inst.id}`,
      instanceId: inst.id,
      ...(inst.snapshots ? { snapshots: inst.snapshots } : {}),
    };
    if (inst.sourceUid) {
      const item = findItem(s, inst.sourceUid);
      if (item) am.item = item;
    }
    out.push(am);
  }

  return out;
}

function findItem(s: GameState, uid: string): StackItem | undefined {
  for (const st of s.stacks) {
    const it = st.items.find((x) => x.uid === uid);
    if (it) return it;
  }
  return undefined;
}

function instanceAlive(s: GameState, duration: string, sourceUid?: string): boolean {
  if (duration === 'whileOnStack') return sourceUid !== undefined && findItem(s, sourceUid) !== undefined;
  return true;
}

/**
 * 種類で絞ったうえで cond を評価して有効なものだけ返す。
 * ダメージ計算・ドロー・targeting からはこれを使う。
 */
export async function activeMods<K extends ContinuousMod['t']>(
  engine: Engine,
  kind: K,
): Promise<(ActiveMod & { mod: Extract<ContinuousMod, { t: K }> })[]> {
  const out: (ActiveMod & { mod: Extract<ContinuousMod, { t: K }> })[] = [];
  for (const am of gatherMods(engine)) {
    if (am.mod.t !== kind) continue;
    const inst = am.instanceId ? engine.state.continuous.find((c) => c.id === am.instanceId) : undefined;
    if (inst?.cond) {
      if (!(await evalCondition(inst.cond, modCtx(engine, am)))) continue;
    }
    const abilityCond = am.item || am.card ? abilityCondFor(engine, am) : undefined;
    if (abilityCond && !(await evalCondition(abilityCond, modCtx(engine, am)))) continue;
    out.push(am as ActiveMod & { mod: Extract<ContinuousMod, { t: K }> });
  }
  return out;
}

/** カードの continuous ability に付いた cond を引く（天水の祝福の「豪雨なら」） */
function abilityCondFor(engine: Engine, am: ActiveMod) {
  const defId = am.card?.defId ?? (am.item?.kind === 'card' ? am.item.card?.defId : undefined);
  if (!defId) return undefined;
  const def = engine.pool.card(defId);
  for (const ab of def.abilities) {
    if (ab.kind === 'continuous' && ab.mod === am.mod) return ab.cond;
  }
  return undefined;
}

// ============================================================
// 汎用の置換効果（replaceEvent）
// ============================================================

/**
 * `replaceEvent` を実際に通している経路。
 * ここに無いイベントの置換は「置き換わらずに素通りする」= 黙って無視することになるので、
 * 付与された時点で `NotImplementedError` にする（`assertReplaceSupported`）。
 */
export const REPLACEABLE_EVENTS: EventKind[] = ['weatherNegate'];

export function assertReplaceSupported(mod: ContinuousMod): void {
  if (mod.t !== 'replaceEvent') return;
  const kinds = Array.isArray(mod.when.on) ? mod.when.on : [mod.when.on];
  for (const k of kinds) {
    if (!REPLACEABLE_EVENTS.includes(k)) {
      throw new NotImplementedError(`イベント "${k}" の置換（replaceEvent）`, mod);
    }
  }
  if (mod.when.subject || mod.when.tags || mod.when.species || mod.when.granularity) {
    throw new NotImplementedError('replaceEvent の subject / tags / species / granularity', mod);
  }
}

/**
 * そのイベントが起きようとするとき、置換効果が代わりの処理を行うか。
 * `true` を返したら**元の処理は行われない**。
 *
 * `with` を省略した置換は「単に打ち消す」（レイジングスカイ）、
 * `optional` なら「代わりに〜してもよい」（雷光顕現）。
 */
export async function tryReplaceEvent(ctx: Ctx, ev: ReplaceableEvent): Promise<boolean> {
  for (const am of await activeMods(ctx.engine, 'replaceEvent')) {
    assertReplaceSupported(am.mod);
    const kinds = Array.isArray(am.mod.when.on) ? am.mod.when.on : [am.mod.when.on];
    if (!kinds.includes(ev.kind)) continue;

    const mctx = modCtx(ctx.engine, am);
    if (am.mod.who !== undefined) {
      if (ev.player === undefined) continue;
      const who = await resolvePlayers(am.mod.who, mctx);
      if (!who.includes(ev.player)) continue;
    }
    if (am.mod.when.filter) {
      if (!ev.itemUid) continue;
      const item = findItem(ctx.engine.state, ev.itemUid);
      if (!item) continue;
      const { matchStack } = await import('./select');
      if (!(await matchStack(item, am.mod.when.filter, mctx))) continue;
    }
    if (am.mod.when.cond && !(await evalCondition(am.mod.when.cond, mctx))) continue;

    if (am.mod.optional) {
      const ok = await ctx.engine.chooser.confirm({
        player: am.controller,
        prompt: `${am.origin}: 代わりの処理を行う？`,
      });
      if (!ok) continue;
    }
    if (am.mod.with) {
      const { resolve } = await import('./effects');
      await resolve(am.mod.with, mctx);
    }
    return true;
  }
  return false;
}

// ============================================================
// 対象に取れるか（untargetable）
// ============================================================

export async function isTargetableItem(ctx: Ctx, it: StackItem): Promise<boolean> {
  if (ctx.engine.targetCheckDepth > 0) return true; // untargetable の内部評価での再帰を切る
  ctx.engine.targetCheckDepth++;
  try {
    const mods = await activeMods(ctx.engine, 'untargetable');
    for (const am of mods) {
      if (!am.mod.items) continue;
      const protectedItems = await resolveStack(am.mod.items, modCtx(ctx.engine, am));
      if (protectedItems.some((x) => x.uid === it.uid)) {
        // 自分のものは自分で選べる（「相手に対象に取られない」の解釈）
        if (ctx.self !== am.controller) return false;
      }
    }
    return true;
  } finally {
    ctx.engine.targetCheckDepth--;
  }
}

export async function isTargetableEntity(ctx: Ctx, e: Entity): Promise<boolean> {
  if (ctx.engine.targetCheckDepth > 0) return true;
  ctx.engine.targetCheckDepth++;
  try {
    const mods = await activeMods(ctx.engine, 'untargetable');
    for (const am of mods) {
      const mctx = modCtx(ctx.engine, am);
      if (am.mod.who) {
        const ps = await resolvePlayers(am.mod.who, mctx);
        if (e.kind === 'player' && ps.includes(e.player) && ctx.self !== am.controller) return false;
      }
      if (am.mod.minions && e.kind === 'minion') {
        const sp = await resolveSpecies(am.mod.minions, mctx);
        if (e.species === sp && e.owner === am.controller && ctx.self !== am.controller) return false;
      }
    }
    return true;
  } finally {
    ctx.engine.targetCheckDepth--;
  }
}

/** 天候の効果を受けないか（weatherImmune） */
export async function isWeatherImmune(engine: Engine, player: PlayerId): Promise<boolean> {
  const mods = await activeMods(engine, 'weatherImmune');
  for (const am of mods) {
    const ws = Array.isArray(am.mod.weather) ? am.mod.weather : [am.mod.weather];
    if (!ws.includes(engine.state.weather)) continue;
    const ps = await resolvePlayers(am.mod.who, modCtx(engine, am));
    if (ps.includes(player)) return true;
  }
  return false;
}

/** 相手の天候変更を打ち消す効果があるか（あれば1回消費して true） */
export async function consumeWeatherPrevention(engine: Engine, changer: PlayerId): Promise<boolean> {
  const mods = await activeMods(engine, 'preventWeatherChange');
  for (const am of mods) {
    const ps = await resolvePlayers(am.mod.by, modCtx(engine, am));
    if (!ps.includes(changer)) continue;
    if (am.instanceId) {
      const inst = engine.state.continuous.find((c) => c.id === am.instanceId);
      if (inst) inst.used = true;
    }
    return true;
  }
  return false;
}

export { opponentOf };
