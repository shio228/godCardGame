/**
 * イベントの記録と誘発の処理。
 *
 * - すべてのイベントは `GameState.events` に積まれる。`countEvent` はこれを数える。
 * - 誘発は即座に実行せず `engine.pending` に積み、安全な地点で `drainTriggers` が流す。
 * - 実行の直前に **暗黙束縛**（count / amount / source / species / delta …）を積む。
 *
 * 誘発順（暫定規約 — 設計書 §10 の宿題）:
 *   ① 先攻プレイヤーの誘発 → ② 後攻プレイヤーの誘発
 *   ③ 同一プレイヤー内に複数あるときはコントローラーが順序を選ぶ
 */
import type { Ability, Effect, Limit, PlayerId, TriggerEvent } from '../rules/types';
import { Scope, withBindings, type Ctx, type Engine, type PendingTrigger } from './context';
import { evalCondition } from './condition';
import { LoopError } from './errors';
import { matchStack, resolvePlayers, resolveStack, matchSpecies, resolveEntities, itemName } from './select';
// objectives.ts とは相互参照になるが、どちらも関数宣言のみを使うため ESM の巻き上げで解決される。
import { checkObjectives, objectiveTriggers } from './objectives';
import { opponentOf, sameEntity, type Bound, type GameEvent, type StackItem } from './state';

export type EmitSpec = Omit<GameEvent, 'seq' | 'cycle' | 'turn' | 'weather'>;

/** イベントをログに積み、該当する誘発を pending に載せる */
export async function emit(ctx: Ctx, spec: EmitSpec): Promise<void> {
  const s = ctx.engine.state;
  const ev: GameEvent = {
    seq: s.events.length,
    cycle: s.cycle,
    turn: s.turn,
    weather: s.weather,
    ...spec,
  };
  s.events.push(ev);
  ctx.engine.pending.push(...(await collectTriggers(ctx.engine, ev)));
}

// ============================================================
// 誘発の発生源
// ============================================================

interface TriggerSource {
  when: TriggerEvent;
  effect: Effect;
  optional?: boolean;
  limit?: Limit;
  controller: PlayerId;
  item?: StackItem;
  origin: string;
  key: string;
  /** thresholds の糖衣展開: カウンタが増えて到達したときだけ発火する */
  requireIncrease?: boolean;
}

function fromAbilities(
  abilities: Ability[],
  where: 'always' | 'onStack' | 'inField' | 'inHand',
  controller: PlayerId,
  origin: string,
  keyBase: string,
  item?: StackItem,
): TriggerSource[] {
  const out: TriggerSource[] = [];
  abilities.forEach((ab, i) => {
    if (ab.kind === 'triggered') {
      if (ab.active !== where && ab.active !== 'always') return;
      const src: TriggerSource = {
        when: ab.when,
        effect: ab.effect,
        controller,
        origin,
        key: `${keyBase}#${i}`,
      };
      if (ab.optional !== undefined) src.optional = ab.optional;
      if (ab.limit !== undefined) src.limit = ab.limit;
      if (item) src.item = item;
      out.push(src);
      return;
    }
    if (ab.kind === 'thresholds') {
      if (ab.active !== where && ab.active !== 'always') return;
      // 「詠唱が3/6/9になったら」= counterChanged + 到達判定 の糖衣構文
      ab.steps.forEach((step, j) => {
        const on = ab.on ?? { t: 'this' as const };
        const src: TriggerSource = {
          when: {
            on: 'counterChanged',
            subject: on,
            cond: { t: 'cmp', a: { t: 'counters', kind: ab.counter, on }, op: '==', b: step.at },
          },
          effect: step.effect,
          controller,
          origin: `${origin}(閾値${step.at})`,
          key: `${keyBase}#${i}.${j}`,
          requireIncrease: true,
        };
        if (item) src.item = item;
        out.push(src);
      });
    }
  });
  return out;
}

function gatherSources(engine: Engine): TriggerSource[] {
  const s = engine.state;
  const out: TriggerSource[] = [];

  for (const pid of ['P1', 'P2'] as PlayerId[]) {
    const god = engine.pool.god(s.players[pid].god);
    if (god) out.push(...fromAbilities(god.passives, 'always', pid, `神:${god.name}`, `god:${pid}`));

    for (const tk of s.players[pid].tokens) {
      if (!tk.equipped) continue;
      const def = engine.pool.token(tk.defId);
      out.push(...fromAbilities(def.abilities, 'inField', pid, `装備:${def.name}`, `token:${tk.uid}`));
    }
    for (const [sp, n] of Object.entries(s.players[pid].minions)) {
      if (n <= 0) continue;
      const def = engine.pool.minion(sp);
      if (def) out.push(...fromAbilities(def.abilities, 'inField', pid, `ミニオン:${def.name}`, `minion:${pid}:${sp}`));
    }
    for (const c of s.players[pid].zones.hand[0] ?? []) {
      const def = engine.pool.card(c.defId);
      out.push(...fromAbilities(def.abilities, 'inHand', pid, `手札:${def.name}`, `hand:${c.uid}`));
    }
  }

  for (const st of s.stacks) {
    for (const it of st.items) {
      if (it.kind === 'card' && it.card) {
        const def = engine.pool.card(it.card.defId);
        out.push(...fromAbilities(def.abilities, 'onStack', it.controller, `カード:${def.name}`, `stack:${it.uid}`, it));
      }
    }
  }

  // ⑤ 公開済みの特殊勝利条件（誘発型）。効果は既定で「あなたは勝利する」
  for (const t of objectiveTriggers(engine)) {
    const src: TriggerSource = {
      when: t.when,
      effect: t.effect,
      controller: t.controller,
      origin: t.origin,
      key: t.key,
    };
    if (t.limit) src.limit = t.limit;
    out.push(src);
  }

  for (const g of s.grantedTriggers) {
    if (g.onceOnly && g.used) continue;
    const src: TriggerSource = {
      when: g.trigger.when,
      effect: g.trigger.effect,
      controller: g.controller,
      origin: `付与:${g.id}`,
      key: `granted:${g.id}`,
    };
    if (g.trigger.optional !== undefined) src.optional = g.trigger.optional;
    if (g.trigger.limit !== undefined) src.limit = g.trigger.limit;
    if (g.sourceUid) {
      for (const st of s.stacks) {
        const it = st.items.find((x) => x.uid === g.sourceUid);
        if (it) src.item = it;
      }
    }
    out.push(src);
  }

  return out;
}

// ============================================================
// マッチング
// ============================================================

function srcCtx(engine: Engine, src: TriggerSource): Ctx {
  const ctx: Ctx = { engine, self: src.controller, vars: new Scope() };
  if (src.item) {
    ctx.item = src.item;
    ctx.stackId = src.item.stackId;
  }
  return ctx;
}

const STACK_TS = ['this', 'top', 'bottom', 'above', 'below', 'choose', 'random', 'all'];
const PLAYER_TS = ['self', 'opponent', 'each', 'controllerOf'];
const ENTITY_TS = ['player', 'minion', 'chooseEntity'];

async function subjectMatches(engine: Engine, src: TriggerSource, ev: GameEvent): Promise<boolean> {
  const ctx = srcCtx(engine, src);
  const subject = src.when.subject;

  if (subject) {
    const t = subject.t;
    if (STACK_TS.includes(t)) {
      if (!ev.itemUid) return false;
      const items = await resolveStack(subject as Parameters<typeof resolveStack>[0], ctx);
      return items.some((i) => i.uid === ev.itemUid);
    }
    if (PLAYER_TS.includes(t)) {
      if (!ev.player) return false;
      const ps = await resolvePlayers(subject as Parameters<typeof resolvePlayers>[0], ctx);
      return ps.includes(ev.player);
    }
    if (ENTITY_TS.includes(t)) {
      if (!ev.entity) return false;
      const es = await resolveEntities(subject as Parameters<typeof resolveEntities>[0], ctx);
      return es.some((e) => ev.entity && sameEntity(e, ev.entity));
    }
    // 'target' / 'var' — スタック項目として解けなければプレイヤーとして解く
    try {
      const items = await resolveStack(subject as Parameters<typeof resolveStack>[0], ctx);
      return !!ev.itemUid && items.some((i) => i.uid === ev.itemUid);
    } catch {
      const ps = await resolvePlayers(subject as Parameters<typeof resolvePlayers>[0], ctx);
      return !!ev.player && ps.includes(ev.player);
    }
  }

  if (src.when.filter) {
    if (!ev.itemUid) return false;
    const item = findItemByUid(engine, ev.itemUid);
    if (!item) return false;
    return matchStack(item, src.when.filter, ctx);
  }

  // 既定: 「このカード自身」 / 自分に起きたこと
  if (ev.itemUid && src.item) return ev.itemUid === src.item.uid;
  if (ev.player !== undefined) return ev.player === src.controller;
  return true;
}

function findItemByUid(engine: Engine, uid: string): StackItem | undefined {
  for (const st of engine.state.stacks) {
    const it = st.items.find((x) => x.uid === uid);
    if (it) return it;
  }
  return undefined;
}

/**
 * 死亡したミニオンの誘発は「盤面から消えたあと」に発火する（死霊の「減った数をxとして」）。
 * 体数が0になった時点で inField の発生源から外れてしまうので、
 * minionDied / minionSacrificed のときだけその種族の能力を明示的に足す。
 */
function dyingMinionSources(engine: Engine, ev: GameEvent): TriggerSource[] {
  if (ev.kind !== 'minionDied' && ev.kind !== 'minionSacrificed') return [];
  if (!ev.species || !ev.player) return [];
  if ((engine.state.players[ev.player].minions[ev.species] ?? 0) > 0) return []; // 既に含まれている
  const def = engine.pool.minion(ev.species);
  if (!def) return [];
  return fromAbilities(def.abilities, 'inField', ev.player, `ミニオン:${def.name}`, `minion:${ev.player}:${ev.species}`);
}

async function collectTriggers(engine: Engine, ev: GameEvent): Promise<PendingTrigger[]> {
  const out: PendingTrigger[] = [];
  for (const src of [...gatherSources(engine), ...dyingMinionSources(engine, ev)]) {
    const kinds = Array.isArray(src.when.on) ? src.when.on : [src.when.on];
    if (!kinds.includes(ev.kind)) continue;
    if (src.requireIncrease) {
      const d = ev.bindings?.delta;
      if (!d || d.of !== 'number' || d.value <= 0) continue;
    }
    if (src.when.tags && !src.when.tags.every((t) => ev.tags?.includes(t))) continue;
    if (src.when.species) {
      if (!ev.species) continue;
      if (!matchSpecies(ev.species, src.when.species, srcCtx(engine, src))) continue;
    }
    if (!(await subjectMatches(engine, src, ev))) continue;

    const bindings: Record<string, Bound> = { ...(ev.bindings ?? {}) };
    if (ev.itemUid && !bindings.source) {
      const it = findItemByUid(engine, ev.itemUid);
      if (it) bindings.source = { of: 'stack', value: [it] };
    }

    if (src.when.cond) {
      const condCtx = withBindings(srcCtx(engine, src), bindings);
      if (!(await evalCondition(src.when.cond, condCtx))) continue;
    }

    if (src.limit && !limitAvailable(engine, src.key, src.limit)) continue;

    // 粒度。既定は perEvent（1回の効果につき1回）
    const gran = src.when.granularity ?? 'perEvent';
    const reps = gran === 'perUnit' ? Math.max(1, ev.units ?? 1) : 1;
    for (let k = 0; k < reps; k++) {
      const b = gran === 'perUnit' ? { ...bindings, count: { of: 'number' as const, value: 1 } } : bindings;
      const pt: PendingTrigger = {
        controller: src.controller,
        effect: src.effect,
        bindings: b,
        label: src.origin,
      };
      if (src.item) pt.item = src.item;
      if (src.optional !== undefined) pt.optional = src.optional;
      if (src.limit) {
        pt.limitKey = src.key;
        pt.limit = src.limit;
      }
      out.push(pt);
    }
  }
  return out;
}

// ============================================================
// Limit
// ============================================================

function limitEpoch(engine: Engine, per: Limit['per']): string {
  const s = engine.state;
  return per === 'game' ? 'g' : per === 'cycle' ? `c${s.cycle}` : `t${s.turn}`;
}

export function limitAvailable(engine: Engine, key: string, limit: Limit): boolean {
  const k = `${limitEpoch(engine, limit.per)}|${key}`;
  return (engine.state.limitUses[k] ?? 0) < limit.count;
}

export function consumeLimit(engine: Engine, key: string, limit: Limit): void {
  const k = `${limitEpoch(engine, limit.per)}|${key}`;
  engine.state.limitUses[k] = (engine.state.limitUses[k] ?? 0) + 1;
}

// ============================================================
// 誘発の実行
// ============================================================

/**
 * 溜まった誘発を規約順に処理する。処理中に新しい誘発が積まれたら続けて処理する。
 */
export async function drainTriggers(engine: Engine): Promise<void> {
  const { resolve } = await import('./effects');
  let guard = 0;
  for (;;) {
    if (++guard > engine.budget) throw new LoopError('誘発が収束しない（無限ループの疑い）');

    // 状況起因の勝利判定。ここが唯一の呼び出し地点で、
    // プレイ後・各項目の解決後・各フェイズはすべてこの関数を通る。
    await checkObjectives(engine);
    if (engine.state.winner) return;
    if (engine.pending.length === 0) return;

    const batch = engine.pending;
    engine.pending = [];
    const ordered = await orderBatch(engine, batch);

    for (const pt of ordered) {
      if (engine.state.winner) return;
      if (pt.optional) {
        const ok = await engine.chooser.confirm({
          player: pt.controller,
          prompt: `${pt.label} の誘発を使う？`,
        });
        if (!ok) continue;
      }
      const ctx: Ctx = { engine, self: pt.controller, vars: new Scope() };
      if (pt.item) {
        ctx.item = pt.item;
        ctx.stackId = pt.item.stackId;
      }
      const withVars = withBindings(ctx, pt.bindings);
      // 発火の直前に消費する（誘発が積まれてから実行までの間に別の誘発が同じ枠を
      // 使う可能性があるため、収集時ではなくここで判定・消費する）
      if (pt.limitKey && pt.limit) {
        if (!limitAvailable(engine, pt.limitKey, pt.limit)) continue;
        consumeLimit(engine, pt.limitKey, pt.limit);
      }
      engine.log.push({ depth: engine.depth, text: `誘発: ${pt.label}` });
      await resolve(pt.effect, withVars);
    }
  }
}

/** 先攻 → 後攻。同一プレイヤー内に複数あればコントローラーが順序を選ぶ */
async function orderBatch(engine: Engine, batch: PendingTrigger[]): Promise<PendingTrigger[]> {
  const first = engine.state.first;
  const out: PendingTrigger[] = [];
  for (const pid of [first, opponentOf(first)]) {
    const mine = batch.filter((b) => b.controller === pid);
    if (mine.length <= 1) {
      out.push(...mine);
      continue;
    }
    const ordered = await engine.chooser.order<PendingTrigger>({
      kind: 'stack',
      player: pid,
      prompt: '誘発の処理順を決める',
      options: mine.map((m) => ({ value: m, label: m.label })),
    });
    out.push(...ordered);
  }
  return out;
}

export { itemName };
