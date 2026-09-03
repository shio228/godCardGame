/**
 * ダメージパイプライン（設計書 §5 の確定仕様）。
 *
 *  1. 基礎値
 *  2. + サイクルボーナス     （ignoreCycleBonus / 雨・豪雨 / 天候ダメージ では乗らない）
 *  3. + 与ダメ加算           damageDelta direction:'dealt'
 *  4. × 乗算                 damageMultiplier（炎天）
 *  ── ここまでが「与えたダメージ」= 誘発 / bind が参照する値 ──
 *  5. 着弾先の差し替え       damageRedirect（防御指令・天使）
 *  6. + 被ダメ加算           damageDelta direction:'taken'
 *  7. − 装甲                 ignoreArmor なら飛ばす
 *     ★ evasionInput = この時点の値を退避
 *  8. − 軽減                 unreducible なら飛ばす
 *  9. 回避判定               evasionInput ≤ evasion なら 0（unavoidable なら飛ばす）
 * 10. − シールド
 * 11. ライフ減算 / ミニオン除去
 *
 * ★ が要点: **回避判定に渡すのは軽減前の値**。軽減後で判定すると回避と軽減の
 * 重ね掛けで完封が容易に成立してしまう。
 */
import type {
  DamageFlags,
  DamageTag,
  PlayerId,
  PlayerSel,
  Species,
  SpeciesFilter,
  StackFilter,
} from '../rules/types';
import { logLine, state, type Ctx } from './context';
import { activeMods, isWeatherImmune, modCtx, type ActiveMod } from './continuous';
import { matchStack, resolvePlayers, resolveEntities, matchSpecies } from './select';
import { emit } from './events';
import {
  entityOwner,
  playerEntity,
  sameEntity,
  setWinner,
  type Entity,
  type StackItem,
} from './state';
import { evalValue } from './value';
import { weatherNoCycleBonus, weatherNoEvasion } from './weather';

export interface DamageSpec {
  to: Entity;
  amount: number;
  tags: DamageTag[];
  species?: Species;
  flags: DamageFlags;
  /**
   * 誰が与えたか。
   * `tags` に `'weather'` を含むダメージは**プレイヤーが与えたものではない**ので、
   * ここに何が入っていても「与える側」としては扱わない（`dealerOf`）。
   */
  dealer: PlayerId;
  /** 発生源のスタック項目 */
  source?: StackItem;
}

export interface DamageResult {
  /** 「与えたダメージ」（段4 の値）。誘発・bind が参照するのはこれ */
  dealt: number;
  /** 実際にライフから引かれた量 */
  applied: number;
  /** 除去したミニオン数 */
  minionsKilled: number;
  /** 最終的な着弾先 */
  target: Entity;
}

/**
 * 「与えた側」。天候ダメージは誰かが与えたものではないので undefined になる。
 *
 * これがないと、炎天や吹雪のダメージが**受けた本人の与えたダメージ**として扱われ、
 * 大地の「攻勢」（与ダメ+1）が乗り、「10回目のダメージを与えたなら勝利」まで進んでしまう。
 * 天候ダメージへの修正は受ける側（`direction:'taken'`）で書く — 気炎万丈の
 * 「炎天のダメージにダメージボーナスが付与される」がその形になっている。
 */
function dealerOf(spec: DamageSpec): PlayerId | undefined {
  return spec.tags.includes('weather') ? undefined : spec.dealer;
}

export async function dealDamage(ctx: Ctx, spec: DamageSpec): Promise<DamageResult> {
  const s = state(ctx);
  const engine = ctx.engine;
  const dealer = dealerOf(spec);

  // ---- 1. 基礎値 ----
  let v = spec.amount;

  // ---- 2. サイクルボーナス ----
  const globalIgnore = (await activeMods(engine, 'ignoreCycleBonus')).length > 0;
  const cardIgnore =
    spec.source?.kind === 'card' && spec.source.card
      ? engine.pool.card(spec.source.card.defId).ignoresCycleBonus === true
      : false;
  const cycleBlocked =
    spec.flags.ignoreCycleBonus === true ||
    cardIgnore ||
    globalIgnore ||
    weatherNoCycleBonus(s.weather) ||
    spec.tags.includes('weather');
  if (!cycleBlocked) v += s.cycle;

  // ---- 3. 与ダメ加算 ----（天候ダメージには「与える側」がいないので乗らない）
  for (const am of await activeMods(engine, 'damageDelta')) {
    if (am.mod.direction !== 'dealt') continue;
    if (!(await modAppliesToDealer(ctx, am, am.mod, spec, dealer))) continue;
    v += await evalValue(am.mod.amount, modCtx(engine, am));
  }

  // ---- 4. 乗算 ----
  for (const am of await activeMods(engine, 'damageMultiplier')) {
    if (am.mod.tags && !am.mod.tags.some((t) => spec.tags.includes(t))) continue;
    if (!(await sourceMatches(ctx, am, am.mod.sourceFilter, spec))) continue;
    v *= await evalValue(am.mod.factor, modCtx(engine, am));
  }

  v = Math.max(0, Math.trunc(v));
  const dealt = v;

  // ---- 追加: 付与されたダメージフラグ（damageFlagGrant）を合流 ----
  const flags: DamageFlags = { ...spec.flags };
  for (const am of await activeMods(engine, 'damageFlagGrant')) {
    if (!(await modAppliesToDealer(ctx, am, am.mod, spec, dealer))) continue;
    Object.assign(flags, am.mod.flags);
  }

  // ---- 5. 着弾先の差し替え ----
  let target = spec.to;
  let carried = v; // ミニオンに割り振ったあとプレイヤーへ流れる分
  let minionsKilled = 0;

  for (const am of await activeMods(engine, 'damageRedirect')) {
    const victim = entityOwner(target);
    const who = await resolvePlayers(am.mod.who, modCtx(engine, am));
    if (!who.includes(victim)) continue;
    if (target.kind !== 'player') continue;
    const dest = (await resolveEntities(am.mod.to, modCtx(engine, am)))[0];
    if (!dest || dest.kind !== 'minion') continue;
    const available = s.players[dest.owner].minions[dest.species] ?? 0;
    if (available <= 0) continue;
    // ミニオンは体力を持たないので 1点 = 1体 で吸収する
    const absorbed = Math.min(available, carried);
    s.players[dest.owner].minions[dest.species] = available - absorbed;
    minionsKilled += absorbed;
    carried -= absorbed;
    if (am.mod.overflow === 'absorb') carried = 0;
    logLine(ctx, `${am.origin}: ${dest.species} が ${absorbed} 体で肩代わり（残り ${carried}）`);
    if (absorbed > 0) {
      await emit(ctx, {
        kind: 'minionDied',
        player: dest.owner,
        species: dest.species,
        units: absorbed,
        bindings: {
          species: { of: 'species', value: dest.species },
          count: { of: 'number', value: absorbed },
        },
      });
    }
    if (carried === 0) break;
  }

  // 着弾先がミニオンそのものなら、そこで体数を減らして終わり
  if (target.kind === 'minion') {
    const available = s.players[target.owner].minions[target.species] ?? 0;
    const killed = Math.min(available, carried);
    s.players[target.owner].minions[target.species] = available - killed;
    minionsKilled += killed;
    if (killed > 0) {
      await emit(ctx, {
        kind: 'minionDied',
        player: target.owner,
        species: target.species,
        units: killed,
        bindings: {
          species: { of: 'species', value: target.species },
          count: { of: 'number', value: killed },
        },
      });
    }
    await emitDamage(ctx, spec, target, dealt, 0);
    return { dealt, applied: 0, minionsKilled, target };
  }

  const victim = target.player;
  v = carried;

  // ---- 完全無効化（damagePrevention・天候免疫）----
  if (await isPrevented(ctx, spec, victim)) {
    logLine(ctx, `ダメージ無効化: ${victim}`);
    await emitDamage(ctx, spec, target, dealt, 0);
    return { dealt, applied: 0, minionsKilled, target };
  }
  if (spec.tags.includes('weather') && (await isWeatherImmune(engine, victim))) {
    await emitDamage(ctx, spec, target, dealt, 0);
    return { dealt, applied: 0, minionsKilled, target };
  }

  // ---- 6. 被ダメ加算 ----
  for (const am of await activeMods(engine, 'damageDelta')) {
    if (am.mod.direction !== 'taken') continue;
    const who = await resolvePlayers(am.mod.who, modCtx(engine, am));
    if (!who.includes(victim)) continue;
    if (am.mod.tags && !am.mod.tags.some((t) => spec.tags.includes(t))) continue;
    v += await evalValue(am.mod.amount, modCtx(engine, am));
  }
  v = Math.max(0, v);

  const p = s.players[victim];

  // ---- 7. 装甲 ----
  if (!flags.ignoreArmor) {
    const used = Math.min(p.status.armor, v);
    v -= used;
  }

  // ★ 回避判定に渡す値をここで退避する
  const evasionInput = v;

  // ---- 8. 軽減 ----
  if (!flags.unreducible) {
    const flat = Math.min(p.status.reduction, v);
    v -= flat;
    for (const am of await activeMods(engine, 'damageReduction')) {
      if (v <= 0) break;
      const who = await resolvePlayers(am.mod.who, modCtx(engine, am));
      if (!who.includes(victim)) continue;
      if (am.mod.tags && !am.mod.tags.some((t) => spec.tags.includes(t))) continue;
      if (am.mod.species && !(spec.species && matchSpecies(spec.species, am.mod.species, modCtx(ctx.engine, am)))) continue;
      if (!(await sourceMatches(ctx, am, am.mod.sourceFilter, spec))) continue;
      const cap = await evalValue(am.mod.amount, modCtx(engine, am));
      const reduced = Math.min(cap, v);
      if (reduced <= 0) continue;
      v -= reduced;
      logLine(ctx, `${am.origin}: ${reduced} 軽減`);
      if (am.mod.onApply) {
        // 置換効果の内部で「実際に軽減した量」を参照する規約（暗黙束縛 reduced）
        const { resolve } = await import('./effects');
        const mctx = modCtx(engine, am);
        mctx.vars.set('reduced', { of: 'number', value: reduced });
        await resolve(am.mod.onApply, mctx);
      }
    }
  }

  // ---- 9. 回避判定（軽減前の値で判定する）----
  // 晴・炎天は「攻撃が必ず当たる」ので回避が働かない（企画書の天候表）。
  // その天候の効果を受けない側（自在の神翼）だけが回避できる。
  const alwaysHits = weatherNoEvasion(s.weather) && !(await isWeatherImmune(engine, victim));
  if (!flags.unavoidable && !alwaysHits && p.status.evasion > 0 && evasionInput <= p.status.evasion) {
    logLine(ctx, `回避: ${evasionInput} ≤ 回避${p.status.evasion}`);
    v = 0;
  }

  // ---- 10. シールド ----
  if (v > 0 && p.status.shield > 0) {
    const used = Math.min(p.status.shield, v);
    p.status.shield -= used;
    consumeStatusGrants(ctx, victim, 'shield', used);
    v -= used;
  }

  // ---- 11. ライフ減算 ----
  const applied = Math.max(0, v);
  if (applied > 0) await changeLife(ctx, victim, -applied);

  await emitDamage(ctx, spec, target, dealt, applied);
  return { dealt, applied, minionsKilled, target };
}

async function emitDamage(
  ctx: Ctx,
  spec: DamageSpec,
  target: Entity,
  dealt: number,
  applied: number,
): Promise<void> {
  const bindings = {
    amount: { of: 'number' as const, value: applied },
    target: { of: 'entity' as const, value: target },
    ...(spec.source ? { source: { of: 'stack' as const, value: [spec.source] } } : {}),
    ...(spec.species ? { species: { of: 'species' as const, value: spec.species } } : {}),
  };
  const dealer = dealerOf(spec);
  const base = {
    tags: spec.tags,
    amount: applied,
    entity: target,
    bindings,
    ...(dealer ? { dealer } : {}),
    ...(spec.source ? { sourceUid: spec.source.uid } : {}),
    ...(spec.species ? { species: spec.species } : {}),
  };
  // dealt が 0 でも「与えた」イベントは出す（measure:'events' で数えたい条件のため）。
  // units は設計書 §5 の用語に合わせて、
  //   damageDealt → 「与えたダメージ」（修正込み・軽減前）
  //   damageTaken → 「実際に通ったダメージ」
  // 天候ダメージには主体がいないので player を載せない（countEvent.by が拾わない）
  await emit(ctx, { kind: 'damageDealt', ...(dealer ? { player: dealer } : {}), ...base, units: dealt });
  await emit(ctx, { kind: 'damageTaken', player: entityOwner(target), ...base, units: applied });
}

async function isPrevented(ctx: Ctx, spec: DamageSpec, victim: PlayerId): Promise<boolean> {
  for (const am of await activeMods(ctx.engine, 'damagePrevention')) {
    const who = await resolvePlayers(am.mod.who, modCtx(ctx.engine, am));
    if (!who.includes(victim)) continue;
    if (am.mod.tags && !am.mod.tags.some((t) => spec.tags.includes(t))) continue;
    if (am.mod.weather) {
      const ws = Array.isArray(am.mod.weather) ? am.mod.weather : [am.mod.weather];
      if (!ws.includes(state(ctx).weather)) continue;
    }
    if (am.mod.species && !(spec.species && matchSpecies(spec.species, am.mod.species, modCtx(ctx.engine, am)))) continue;
    if (!(await sourceMatches(ctx, am, am.mod.sourceFilter, spec))) continue;
    return true;
  }
  return false;
}

/** 「与える側」で絞る継続的効果に共通する形（damageDelta / damageFlagGrant …） */
interface DealerScopedMod {
  who: PlayerSel;
  tags?: DamageTag[] | undefined;
  species?: SpeciesFilter | undefined;
  sourceFilter?: StackFilter | undefined;
}

async function modAppliesToDealer(
  ctx: Ctx,
  am: ActiveMod,
  mod: DealerScopedMod,
  spec: DamageSpec,
  dealer: PlayerId | undefined,
): Promise<boolean> {
  if (dealer === undefined) return false;
  const who = await resolvePlayers(mod.who, modCtx(ctx.engine, am));
  if (!who.includes(dealer)) return false;
  if (mod.tags && !mod.tags.some((t) => spec.tags.includes(t))) return false;
  if (mod.species && !(spec.species && matchSpecies(spec.species, mod.species, modCtx(ctx.engine, am)))) return false;
  if (mod.sourceFilter) {
    if (!spec.source) return false;
    if (!(await matchStack(spec.source, mod.sourceFilter, modCtx(ctx.engine, am)))) return false;
  }
  return true;
}

async function sourceMatches(
  ctx: Ctx,
  am: ActiveMod,
  sourceFilter: StackFilter | undefined,
  spec: DamageSpec,
): Promise<boolean> {
  if (!sourceFilter) return true;
  if (!spec.source) return false;
  return matchStack(spec.source, sourceFilter, modCtx(ctx.engine, am));
}

// ============================================================
// ライフ変動（置換効果を必ず通す）
// ============================================================

/**
 * ライフの増減はすべてここを通す。直接 `p.life -= x` を書ける場所を作らないのが
 * 置換効果（根性 = lethalReplacement）が確実に働くための条件。
 */
export async function changeLife(ctx: Ctx, who: PlayerId, delta: number): Promise<void> {
  const s = state(ctx);
  const p = s.players[who];
  let next = p.life + delta;

  if (next <= 0) {
    for (const am of await activeMods(ctx.engine, 'lethalReplacement')) {
      const targets = await resolvePlayers(am.mod.who, modCtx(ctx.engine, am));
      if (!targets.includes(who)) continue;
      if (am.instanceId) {
        const inst = s.continuous.find((c) => c.id === am.instanceId);
        if (inst?.onceOnly) {
          if (inst.used) continue;
          inst.used = true;
        }
      }
      next = await evalValue(am.mod.setLifeTo, modCtx(ctx.engine, am));
      logLine(ctx, `${am.origin}: ライフ0以下を肩代わり → ${next}`);
      if (am.mod.then) {
        const { resolve } = await import('./effects');
        await resolve(am.mod.then, modCtx(ctx.engine, am));
      }
      break;
    }
  }

  const actual = next - p.life;
  p.life = next;
  await emit(ctx, {
    kind: 'lifeChanged',
    player: who,
    units: Math.abs(actual),
    bindings: { delta: { of: 'number', value: actual } },
  });

  if (p.life <= 0) {
    setWinner(s, who === 'P1' ? 'P2' : 'P1', 'ライフ0');
  }
}

// ============================================================
// 状態（シールド等）の消費
// ============================================================

export function consumeStatusGrants(ctx: Ctx, who: PlayerId, kind: 'shield', amount: number): void {
  let left = amount;
  const grants = state(ctx).players[who].statusGrants;
  for (const g of grants) {
    if (left <= 0) break;
    if (g.kind !== kind) continue;
    const used = Math.min(g.amount, left);
    g.amount -= used;
    left -= used;
  }
  state(ctx).players[who].statusGrants = grants.filter((g) => g.amount > 0);
}

export { playerEntity, sameEntity };
