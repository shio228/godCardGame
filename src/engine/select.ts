/**
 * セレクタの評価。
 *
 * 確定事項「対象・スタック位置は解決時に評価する（プレイ時ロックしない）」に従い、
 * ここで実際に盤面を見て候補を作り、必要なら Chooser に選ばせる。
 */
import type {
  CardFilter,
  CardSel,
  EntitySel,
  PlayerId,
  PlayerSel,
  Species,
  SpeciesFilter,
  SpeciesRef,
  StackFilter,
  StackSel,
  TokenFilter,
  TokenSel,
  ZoneRef,
  Effect,
  God,
  Keyword,
} from '../rules/types';
import type { Option } from './chooser';
import { logLine, lookupOpt, pool, state, type Ctx } from './context';
import { BindingError, RuleError, unreachable } from './errors';
import { isTargetableEntity, isTargetableItem } from './continuous';
import {
  opponentOf,
  playerEntity,
  rngInt,
  type CardInstance,
  type Entity,
  type Pile,
  type StackItem,
  type TokenInstance,
} from './state';
import { evalValue } from './value';

// ============================================================
// PlayerSel
// ============================================================

export async function resolvePlayers(sel: PlayerSel, ctx: Ctx): Promise<PlayerId[]> {
  switch (sel.t) {
    case 'self':
      return [ctx.self];
    case 'opponent':
      return [opponentOf(ctx.self)];
    case 'each':
      return [state(ctx).first, opponentOf(state(ctx).first)];
    case 'target': {
      const ents = await resolveEntities({ t: 'target' }, ctx);
      return ents.map((e) => (e.kind === 'player' ? e.player : e.owner));
    }
    case 'controllerOf': {
      const items = await resolveStack(sel.of, ctx);
      return items.map((i) => i.controller);
    }
    case 'var': {
      const b = lookupOpt(ctx, sel.name);
      if (!b) throw new BindingError(`束縛 "${sel.name}" が見つからない`);
      if (b.of === 'player') return [b.value];
      if (b.of === 'entity') return [b.value.kind === 'player' ? b.value.player : b.value.owner];
      throw new BindingError(`束縛 "${sel.name}" はプレイヤーとして読めない`);
    }
    default:
      return unreachable(sel, 'PlayerSel');
  }
}

export async function resolvePlayerOne(sel: PlayerSel, ctx: Ctx): Promise<PlayerId> {
  const ps = await resolvePlayers(sel, ctx);
  const p = ps[0];
  if (!p) throw new RuleError(`PlayerSel が誰も指していない: ${JSON.stringify(sel)}`);
  return p;
}

// ============================================================
// SpeciesRef / SpeciesFilter
// ============================================================

export async function resolveSpecies(ref: SpeciesRef, ctx: Ctx): Promise<Species> {
  if (typeof ref === 'string') return ref;
  switch (ref.t) {
    case 'var': {
      const b = lookupOpt(ctx, ref.name);
      if (!b || b.of !== 'species') throw new BindingError(`種族の束縛 "${ref.name}" が見つからない`);
      return b.value;
    }
    case 'any':
    case 'choose': {
      const chooser = ref.t === 'choose' && ref.chooser ? ref.chooser : ({ t: 'self' } as PlayerSel);
      const who = await resolvePlayerOne(chooser, ctx);
      let candidates = speciesUniverse(ctx, who);
      if (ref.t === 'choose') {
        if (ref.exclude) {
          const ex = await resolveSpecies(ref.exclude, ctx);
          candidates = candidates.filter((sp) => sp !== ex);
        }
        if (ref.onlyExisting) {
          const existing = candidates.filter((sp) => (state(ctx).players[who].minions[sp] ?? 0) > 0);
          // 1体も持っていないなら絞り込みを外す。
          // 「0体での攻撃指令」は合法で、x が 0 になるだけ（ダメージイベントは出る）。
          // ここで例外にすると、ミニオンを失った状態の攻撃指令でゲームが止まってしまう。
          if (existing.length > 0) candidates = existing;
        }
      }
      if (candidates.length === 0) throw new RuleError('選べる種族がない');
      if (candidates.length === 1) return candidates[0]!;
      const picked = await ctx.engine.chooser.select<Species>({
        kind: 'species',
        player: who,
        prompt: '種族を1つ選ぶ',
        options: candidates.map((sp) => ({ value: sp, label: pool(ctx).minion(sp)?.name ?? sp })),
        min: 1,
        max: 1,
      });
      const first = picked[0];
      if (!first) throw new RuleError('種族が選ばれなかった');
      return first;
    }
    default:
      return unreachable(ref, 'SpeciesRef');
  }
}

function speciesUniverse(ctx: Ctx, who: PlayerId): Species[] {
  const god = pool(ctx).god(state(ctx).players[who].god);
  if (god?.species?.length) return [...god.species];
  return [...pool(ctx).minions.keys()];
}

export function matchSpecies(sp: Species, filter: SpeciesFilter, ctx: Ctx): boolean {
  const norm = (x: SpeciesRef | SpeciesRef[] | undefined): Species[] => {
    if (x === undefined) return [];
    const arr = Array.isArray(x) ? x : [x];
    return arr.map((r) => {
      if (typeof r === 'string') return r;
      if (r.t === 'var') {
        const b = lookupOpt(ctx, r.name);
        if (!b || b.of !== 'species') throw new BindingError(`種族の束縛 "${r.name}" が見つからない`);
        return b.value;
      }
      throw new BindingError('SpeciesFilter に choose / any は使えない');
    });
  };
  const is = norm(filter.is);
  const not = norm(filter.not);
  if (is.length > 0 && !is.includes(sp)) return false;
  if (not.includes(sp)) return false;
  return true;
}

// ============================================================
// EntitySel
// ============================================================

export async function resolveEntities(sel: EntitySel, ctx: Ctx): Promise<Entity[]> {
  const s = state(ctx);
  switch (sel.t) {
    case 'player': {
      const ps = await resolvePlayers(sel.who, ctx);
      return ps.map(playerEntity);
    }
    case 'minion': {
      const owner = await resolvePlayerOne(sel.owner, ctx);
      const sp = await resolveSpecies(sel.species, ctx);
      return [{ kind: 'minion', species: sp, owner }];
    }
    case 'var': {
      const b = lookupOpt(ctx, sel.name);
      if (!b) throw new BindingError(`束縛 "${sel.name}" が見つからない`);
      if (b.of === 'entity') return [b.value];
      if (b.of === 'player') return [playerEntity(b.value)];
      throw new BindingError(`束縛 "${sel.name}" は着弾先として読めない`);
    }
    case 'target': {
      if (ctx.targets && ctx.targets.length > 0) return ctx.targets;
      // 「対象」が未確定なら解決時にここで選ぶ（確定事項: 解決時に評価）
      const candidates: Entity[] = [];
      for (const e of allEntities(ctx)) if (await isTargetableEntity(ctx, e)) candidates.push(e);
      if (candidates.length === 0) throw new RuleError('対象に取れるものがない');
      const picked = await ctx.engine.chooser.select<Entity>({
        kind: 'entity',
        player: ctx.self,
        prompt: '対象を選ぶ',
        options: candidates.map((e) => ({ value: e, label: entityLabel(ctx, e) })),
        min: 1,
        max: 1,
      });
      return picked;
    }
    case 'chooseEntity': {
      const who = sel.chooser ? await resolvePlayerOne(sel.chooser, ctx) : ctx.self;
      const cands: Entity[] = [];
      if (sel.among.includes('self')) cands.push(playerEntity(ctx.self));
      if (sel.among.includes('opponent')) cands.push(playerEntity(opponentOf(ctx.self)));
      if (sel.among.includes('minion')) {
        const only = sel.species ? await resolveSpecies(sel.species, ctx) : undefined;
        for (const pid of ['P1', 'P2'] as PlayerId[]) {
          for (const [sp, n] of Object.entries(s.players[pid].minions)) {
            if (n <= 0) continue;
            if (only && sp !== only) continue;
            cands.push({ kind: 'minion', species: sp, owner: pid });
          }
        }
      }
      const legal: Entity[] = [];
      for (const e of cands) if (await isTargetableEntity(ctx, e)) legal.push(e);
      if (legal.length === 0) throw new RuleError('選べる着弾先がない');
      if (legal.length === 1) return legal;
      return ctx.engine.chooser.select<Entity>({
        kind: 'entity',
        player: who,
        prompt: '着弾先を選ぶ',
        options: legal.map((e) => ({ value: e, label: entityLabel(ctx, e) })),
        min: 1,
        max: 1,
      });
    }
    default:
      return unreachable(sel, 'EntitySel');
  }
}

function allEntities(ctx: Ctx): Entity[] {
  const s = state(ctx);
  const out: Entity[] = [playerEntity('P1'), playerEntity('P2')];
  for (const pid of ['P1', 'P2'] as PlayerId[]) {
    for (const [sp, n] of Object.entries(s.players[pid].minions)) {
      if (n > 0) out.push({ kind: 'minion', species: sp, owner: pid });
    }
  }
  return out;
}

export function entityLabel(ctx: Ctx, e: Entity): string {
  if (e.kind === 'player') return e.player;
  return `${e.owner}の${pool(ctx).minion(e.species)?.name ?? e.species}`;
}

// ============================================================
// StackSel
// ============================================================

export function scopeItems(ctx: Ctx, scope: 'thisStack' | 'allStacks' | undefined): StackItem[] {
  const s = state(ctx);
  if (scope === 'allStacks') return s.stacks.flatMap((x) => x.items);
  const id = ctx.stackId ?? ctx.item?.stackId;
  const st = (id && s.stacks.find((x) => x.id === id)) || s.stacks[0];
  return st ? [...st.items] : [];
}

export interface StackSelOptions {
  /**
   * **解決中の項目を候補から外す**（企画側判断・2026-09-06）。
   *
   * 解決中のカードはまだスタック上にあるので、放っておくと
   * 「自分自身を手札に戻す → 手札が減らないまま打ち直す」が無限に回る
   * （ループ・ザ・ループ / 熟達した跳躍）。スタックから出す効果はこれを立てる。
   */
  excludeResolving?: boolean;
}

export async function resolveStack(
  sel: StackSel,
  ctx: Ctx,
  opts: StackSelOptions = {},
): Promise<StackItem[]> {
  const picked = await resolveStackInner(sel, ctx, opts);
  if (!opts.excludeResolving) return picked;
  const out = picked.filter((it) => !ctx.engine.resolving.has(it.uid));
  // 黙って減らさない。何が外れたかはログに出す
  for (const it of picked) {
    if (ctx.engine.resolving.has(it.uid)) logLine(ctx, `${itemName(ctx, it)} は解決中なのでスタックから動かせない`);
  }
  return out;
}

async function resolveStackInner(sel: StackSel, ctx: Ctx, opts: StackSelOptions): Promise<StackItem[]> {
  switch (sel.t) {
    case 'this': {
      if (!ctx.item) throw new RuleError("StackSel 'this' だが、この効果はスタック項目に紐づいていない");
      return [ctx.item];
    }
    case 'top': {
      const items = scopeItems(ctx, undefined);
      const i = items.length - 1 - (sel.offset ?? 0);
      const it = items[i];
      return it ? [it] : [];
    }
    case 'bottom': {
      const items = scopeItems(ctx, undefined);
      const it = items[sel.offset ?? 0];
      return it ? [it] : [];
    }
    case 'above':
    case 'below': {
      const base = (await resolveStackInner(sel.of, ctx, opts))[0];
      if (!base) return [];
      const items = scopeItems(ctx, undefined);
      const idx = items.findIndex((x) => x.uid === base.uid);
      if (idx < 0) return [];
      const n = sel.n ?? 1;
      return sel.t === 'above' ? items.slice(idx + 1, idx + 1 + n) : items.slice(Math.max(0, idx - n), idx);
    }
    case 'all': {
      const items = scopeItems(ctx, sel.filter?.scope);
      const out: StackItem[] = [];
      for (const it of items) if (await matchStack(it, sel.filter, ctx)) out.push(it);
      return out;
    }
    case 'random': {
      const items = scopeItems(ctx, sel.filter?.scope);
      const pool2: StackItem[] = [];
      for (const it of items) if (await matchStack(it, sel.filter, ctx)) pool2.push(it);
      const n = Math.min(await evalValue(sel.count, ctx), pool2.length);
      const out: StackItem[] = [];
      for (let k = 0; k < n; k++) out.push(...pool2.splice(rngInt(state(ctx), pool2.length), 1));
      return out;
    }
    case 'choose': {
      const who = sel.chooser ? await resolvePlayerOne(sel.chooser, ctx) : ctx.self;
      const items = scopeItems(ctx, sel.filter?.scope);
      const cands: StackItem[] = [];
      for (const it of items) {
        if (!(await matchStack(it, sel.filter, ctx))) continue;
        if (!(await isTargetableItem(ctx, it))) continue;
        if (opts.excludeResolving && ctx.engine.resolving.has(it.uid)) continue;
        cands.push(it);
      }
      const count = await evalValue(sel.count, ctx);
      const max = Math.min(count, cands.length);
      if (max === 0) return [];
      return ctx.engine.chooser.select<StackItem>({
        kind: 'stack',
        player: who,
        prompt: `スタック上の項目を${sel.upTo ? '最大' : ''}${count}つ選ぶ`,
        options: cands.map((it) => ({ value: it, label: itemLabel(ctx, it) })),
        min: sel.upTo ? 0 : max,
        max,
      });
    }
    case 'var': {
      const b = lookupOpt(ctx, sel.name);
      if (!b) throw new BindingError(`束縛 "${sel.name}" が見つからない`);
      if (b.of !== 'stack') throw new BindingError(`束縛 "${sel.name}" はスタック項目として読めない`);
      return b.value;
    }
    default:
      return unreachable(sel, 'StackSel');
  }
}

export function itemLabel(ctx: Ctx, it: StackItem): string {
  return `${itemName(ctx, it)}(${it.controller})`;
}

export function itemName(ctx: Ctx, it: StackItem): string {
  if (it.kind === 'card' && it.card) return pool(ctx).card(it.card.defId).name;
  if (it.kind === 'action' && it.actionId) return pool(ctx).action(it.actionId).name;
  return it.text ?? '効果';
}

export function itemGod(ctx: Ctx, it: StackItem): God | undefined {
  if (it.kind === 'card' && it.card) return pool(ctx).card(it.card.defId).god;
  if (it.kind === 'action' && it.actionId) return pool(ctx).action(it.actionId).god;
  return undefined;
}

function itemTypes(ctx: Ctx, it: StackItem): string[] {
  if (it.kind === 'card' && it.card) return pool(ctx).card(it.card.defId).types;
  return [];
}

function itemKeywords(ctx: Ctx, it: StackItem): Keyword[] {
  if (it.kind === 'card' && it.card) return pool(ctx).card(it.card.defId).keywords ?? [];
  return [];
}

/** その項目がダメージを与えうるか（StackFilter.dealsDamage） */
export function itemDealsDamage(ctx: Ctx, it: StackItem): boolean {
  if (it.kind === 'card' && it.card) {
    const def = pool(ctx).card(it.card.defId);
    return def.abilities.some((ab) => 'effect' in ab && ab.effect !== undefined && effectDealsDamage(ab.effect));
  }
  if (it.kind === 'action' && it.actionId) return effectDealsDamage(pool(ctx).action(it.actionId).effect);
  if (it.effect) return effectDealsDamage(it.effect);
  return false;
}

/** 効果の木を走査して damage ノードがあるか調べる */
export function effectDealsDamage(e: Effect): boolean {
  if (e.t === 'damage' || e.t === 'loseLife') return true;
  const kids: Effect[] = [];
  if (e.t === 'seq') kids.push(...e.of);
  if (e.t === 'repeat') kids.push(e.body);
  if (e.t === 'if') {
    kids.push(e.then);
    if (e.else) kids.push(e.else);
  }
  if (e.t === 'forEach') kids.push(e.body);
  if (e.t === 'optional') kids.push(e.body);
  if (e.t === 'while') {
    kids.push(e.body);
    if (e.cost) kids.push(e.cost);
  }
  if (e.t === 'modal') kids.push(...e.modes.map((m) => m.effect));
  if (e.t === 'bind') kids.push(e.of, e.then);
  if (e.t === 'let') kids.push(e.then);
  if (e.t === 'addToStack' && e.payload.t === 'effect') kids.push(e.payload.effect);
  return kids.some(effectDealsDamage);
}

export async function matchStack(it: StackItem, f: StackFilter | undefined, ctx: Ctx): Promise<boolean> {
  if (!f) return true;
  if (f.not && (await matchStack(it, f.not, ctx))) return false;
  if (f.is) {
    const targets = await resolveStack(f.is, ctx);
    if (!targets.some((x) => x.uid === it.uid)) return false;
  }
  if (f.controller) {
    const ps = await resolvePlayers(f.controller, ctx);
    if (!ps.includes(it.controller)) return false;
  }
  if (f.god) {
    const gs = Array.isArray(f.god) ? f.god : [f.god];
    const g = itemGod(ctx, it);
    if (!g || !gs.includes(g)) return false;
  }
  if (f.hasType) {
    const ts = Array.isArray(f.hasType) ? f.hasType : [f.hasType];
    const own = itemTypes(ctx, it);
    if (!ts.some((t) => own.includes(t))) return false;
  }
  if (f.name && itemName(ctx, it) !== f.name) return false;
  if (f.nameContains && !itemName(ctx, it).includes(f.nameContains)) return false;
  if (f.sameNameAs) {
    const others = await resolveStack(f.sameNameAs, ctx);
    const names = others.map((o) => itemName(ctx, o));
    if (!names.includes(itemName(ctx, it))) return false;
  }
  if (f.hasKeyword && !itemKeywords(ctx, it).includes(f.hasKeyword)) return false;
  if (f.kind) {
    const ks = Array.isArray(f.kind) ? f.kind : [f.kind];
    if (!ks.includes(it.kind)) return false;
  }
  if (f.hasCounter && (it.counters[f.hasCounter] ?? 0) <= 0) return false;
  if (f.actionId && it.actionId !== f.actionId) return false;
  if (f.dealsDamage !== undefined && itemDealsDamage(ctx, it) !== f.dealsDamage) return false;
  return true;
}

// ============================================================
// ZoneRef / CardSel
// ============================================================

/** ZoneRef が指す山の一覧（デッキは分割されうる） */
export async function resolveZonePiles(ref: ZoneRef, ctx: Ctx): Promise<Pile[]> {
  const s = state(ctx);
  const owners = await resolvePlayers(ref.owner, ctx);
  const out: Pile[] = [];
  for (const o of owners) {
    const piles = s.players[o].zones[ref.zone];
    if (ref.pile === undefined) {
      out.push(...piles);
    } else if (typeof ref.pile === 'object' && 't' in ref.pile && ref.pile.t === 'any') {
      out.push(...piles);
    } else {
      out.push(await pickPile(ref, piles, ctx, o));
    }
  }
  return out;
}

/** カードを入れる先など「1つの山」が必要な場面 */
export async function resolveZonePile(ref: ZoneRef, ctx: Ctx): Promise<Pile> {
  const s = state(ctx);
  const owner = await resolvePlayerOne(ref.owner, ctx);
  const piles = s.players[owner].zones[ref.zone];
  if (ref.pile === undefined) return piles[0]!;
  if (typeof ref.pile === 'object' && 't' in ref.pile && ref.pile.t === 'any') return piles[0]!;
  return pickPile(ref, piles, ctx, owner);
}

async function pickPile(ref: ZoneRef, piles: Pile[], ctx: Ctx, owner: PlayerId): Promise<Pile> {
  const p = ref.pile;
  if (p === undefined) return piles[0]!;
  if (typeof p === 'object' && 't' in p && p.t === 'choose') {
    const who = p.chooser ? await resolvePlayerOne(p.chooser, ctx) : ctx.self;
    const picked = await ctx.engine.chooser.select<number>({
      kind: 'pile',
      player: who,
      prompt: `${owner} の${ref.zone}の山を選ぶ`,
      options: piles.map((pile, i) => ({ value: i, label: `山${i + 1} (${pile.length}枚)` })),
      min: 1,
      max: 1,
    });
    return piles[picked[0] ?? 0] ?? piles[0]!;
  }
  if (typeof p === 'object' && 't' in p && p.t === 'any') return piles[0]!;
  const idx = await evalValue(p, ctx);
  return piles[idx] ?? piles[0]!;
}

export async function resolveCards(sel: CardSel, ctx: Ctx): Promise<CardInstance[]> {
  switch (sel.t) {
    case 'var': {
      const b = lookupOpt(ctx, sel.name);
      if (!b) throw new BindingError(`束縛 "${sel.name}" が見つからない`);
      if (b.of !== 'card') throw new BindingError(`束縛 "${sel.name}" はカードとして読めない`);
      return b.value;
    }
    case 'top': {
      const pile = await resolveZonePile(sel.from, ctx);
      const n = await evalValue(sel.count, ctx);
      return pile.slice(Math.max(0, pile.length - n)).reverse();
    }
    case 'bottom': {
      const pile = await resolveZonePile(sel.from, ctx);
      const n = await evalValue(sel.count, ctx);
      return pile.slice(0, n);
    }
    case 'all': {
      const piles = await resolveZonePiles(sel.from, ctx);
      const out: CardInstance[] = [];
      for (const pile of piles) for (const c of pile) if (await matchCard(c, sel.filter, ctx)) out.push(c);
      return out;
    }
    case 'random': {
      const piles = await resolveZonePiles(sel.from, ctx);
      const cands: CardInstance[] = [];
      for (const pile of piles) for (const c of pile) if (await matchCard(c, sel.filter, ctx)) cands.push(c);
      const n = Math.min(await evalValue(sel.count, ctx), cands.length);
      const out: CardInstance[] = [];
      for (let k = 0; k < n; k++) out.push(...cands.splice(rngInt(state(ctx), cands.length), 1));
      return out;
    }
    case 'choose': {
      const who = sel.chooser ? await resolvePlayerOne(sel.chooser, ctx) : ctx.self;
      const piles = await resolveZonePiles(sel.from, ctx);
      const cands: CardInstance[] = [];
      for (const pile of piles) for (const c of pile) if (await matchCard(c, sel.filter, ctx)) cands.push(c);
      const count = await evalValue(sel.count, ctx);
      const max = Math.min(count, cands.length);
      if (max === 0) return [];
      const opts: Option<CardInstance>[] = cands.map((c) => ({ value: c, label: pool(ctx).card(c.defId).name }));
      return ctx.engine.chooser.select<CardInstance>({
        kind: 'card',
        player: who,
        prompt: `カードを${sel.upTo ? '最大' : ''}${count}枚選ぶ`,
        options: opts,
        min: sel.upTo ? 0 : max,
        max,
      });
    }
    default:
      return unreachable(sel, 'CardSel');
  }
}

export async function matchCard(c: CardInstance, f: CardFilter | undefined, ctx: Ctx): Promise<boolean> {
  if (!f) return true;
  if (f.not && (await matchCard(c, f.not, ctx))) return false;
  if (f.is) {
    const set = await resolveCards(f.is, ctx);
    if (!set.some((x) => x.uid === c.uid)) return false;
  }
  const def = pool(ctx).card(c.defId);
  if (f.god) {
    const gs = Array.isArray(f.god) ? f.god : [f.god];
    if (!gs.includes(def.god)) return false;
  }
  if (f.hasType) {
    const ts = Array.isArray(f.hasType) ? f.hasType : [f.hasType];
    if (!ts.some((t) => def.types.includes(t))) return false;
  }
  if (f.name && def.name !== f.name) return false;
  if (f.nameContains && !def.name.includes(f.nameContains)) return false;
  if (f.hasKeyword && !(def.keywords ?? []).includes(f.hasKeyword)) return false;
  return true;
}

// ============================================================
// TokenSel
// ============================================================

export async function resolveTokens(sel: TokenSel, ctx: Ctx): Promise<TokenInstance[]> {
  const s = state(ctx);
  const all = [...s.players.P1.tokens, ...s.players.P2.tokens];
  switch (sel.t) {
    case 'var': {
      const b = lookupOpt(ctx, sel.name);
      if (!b) throw new BindingError(`束縛 "${sel.name}" が見つからない`);
      if (b.of !== 'token') throw new BindingError(`束縛 "${sel.name}" はトークンとして読めない`);
      return b.value;
    }
    case 'all': {
      const out: TokenInstance[] = [];
      for (const t of all) if (await matchToken(t, sel.filter, ctx)) out.push(t);
      return out;
    }
    case 'choose': {
      const who = sel.chooser ? await resolvePlayerOne(sel.chooser, ctx) : ctx.self;
      const cands: TokenInstance[] = [];
      for (const t of all) if (await matchToken(t, sel.filter, ctx)) cands.push(t);
      const count = await evalValue(sel.count, ctx);
      const max = Math.min(count, cands.length);
      if (max === 0) return [];
      return ctx.engine.chooser.select<TokenInstance>({
        kind: 'token',
        player: who,
        prompt: `トークンを${sel.upTo ? '最大' : ''}${count}つ選ぶ`,
        options: cands.map((t) => ({ value: t, label: pool(ctx).token(t.defId).name })),
        min: sel.upTo ? 0 : max,
        max,
      });
    }
    default:
      return unreachable(sel, 'TokenSel');
  }
}

export async function matchToken(t: TokenInstance, f: TokenFilter | undefined, ctx: Ctx): Promise<boolean> {
  if (!f) return true;
  if (f.not && (await matchToken(t, f.not, ctx))) return false;
  const def = pool(ctx).token(t.defId);
  if (f.kind) {
    const ks = Array.isArray(f.kind) ? f.kind : [f.kind];
    if (!ks.includes(def.kind)) return false;
  }
  if (f.name && def.name !== f.name) return false;
  if (f.owner) {
    const ps = await resolvePlayers(f.owner, ctx);
    if (!ps.includes(t.owner)) return false;
  }
  if (f.notEquipped && (t.equipped || def.kind === 'relic')) return false;
  if (f.mark && t.mark !== f.mark) return false;
  return true;
}
