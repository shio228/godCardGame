/** 数値式（Value）の評価。 */
import type { PlayerId, Species, SpeciesFilter, SpeciesRef, Value } from '../rules/types';
import { lookupOpt, state, type Ctx } from './context';
import { BindingError, unreachable } from './errors';
import {
  matchCard,
  matchSpecies,
  matchStack,
  resolveCards,
  resolvePlayerOne,
  resolveStack,
  resolveTokens,
  resolveZonePiles,
  scopeItems,
} from './select';
import type { Bound, GameEvent } from './state';

/** 束縛を数値として読む。集合なら要素数。 */
export function boundToNumber(b: Bound, name = '?'): number {
  switch (b.of) {
    case 'number':
      return b.value;
    case 'stack':
    case 'card':
    case 'token':
      return b.value.length;
    default:
      throw new BindingError(`束縛 "${name}" は数値として読めない (of=${b.of})`);
  }
}

export async function evalValue(v: Value, ctx: Ctx): Promise<number> {
  if (typeof v === 'number') return v;
  const s = state(ctx);

  switch (v.t) {
    case 'cycle':
      return s.cycle;

    case 'var': {
      const b = lookupOpt(ctx, v.name);
      if (!b) throw new BindingError(`束縛 "${v.name}" が見つからない`);
      return boundToNumber(b, v.name);
    }

    case 'countOf': {
      const b = lookupOpt(ctx, v.name);
      if (!b) throw new BindingError(`束縛 "${v.name}" が見つからない`);
      return boundToNumber(b, v.name);
    }

    case 'snapshotValue': {
      const b = ctx.item?.snapshots[v.name];
      if (!b) throw new BindingError(`snapshot "${v.name}" が見つからない`);
      return boundToNumber(b, v.name);
    }

    case 'counters': {
      const items = await resolveStack(v.on, ctx);
      return items.reduce((a, it) => a + (it.counters[v.kind] ?? 0), 0);
    }

    case 'playerCounter': {
      const p = await resolvePlayerOne(v.of, ctx);
      return s.players[p].counters[v.kind] ?? 0;
    }

    case 'life': {
      const p = await resolvePlayerOne(v.of, ctx);
      return s.players[p].life;
    }

    case 'status': {
      const p = await resolvePlayerOne(v.of, ctx);
      return s.players[p].status[v.kind];
    }

    case 'countStack': {
      const items = scopeItems(ctx, v.filter?.scope);
      let n = 0;
      for (const it of items) if (await matchStack(it, v.filter, ctx)) n++;
      return n;
    }

    case 'countZone': {
      const piles = await resolveZonePiles(v.of, ctx);
      let n = 0;
      for (const pile of piles) {
        for (const c of pile) if (await matchCard(c, v.filter, ctx)) n++;
      }
      return n;
    }

    case 'countTokens': {
      return (await resolveTokens({ t: 'all', ...(v.filter ? { filter: v.filter } : {}) }, ctx)).length;
    }

    case 'countMinions': {
      const p = await resolvePlayerOne(v.of, ctx);
      return countMinionsMatching(ctx, p, v.species);
    }

    case 'countSpeciesKinds': {
      const kinds = new Set<Species>();
      for (const ev of s.events) {
        if (v.event && ev.kind !== v.event) continue;
        if (!inScope(ev, ctx, v.scope ?? 'game')) continue;
        if (v.of && ev.player !== (await resolvePlayerOne(v.of, ctx))) continue;
        if (!ev.species) continue;
        if (v.species && !matchSpecies(ev.species, v.species, ctx)) continue;
        kinds.add(ev.species);
      }
      return kinds.size;
    }

    case 'consecutiveRun': {
      const from = (await resolveStack(v.from, ctx))[0];
      if (!from) return 0;
      const items = scopeItems(ctx, 'thisStack');
      const idx = items.findIndex((x) => x.uid === from.uid);
      if (idx < 0) return 0;
      const owner = v.controller ? await resolvePlayerOne(v.controller, ctx) : from.controller;
      let n = v.includeSelf === false ? 0 : from.controller === owner ? 1 : 0;
      for (let i = idx - 1; i >= 0 && items[i]!.controller === owner; i--) n++;
      for (let i = idx + 1; i < items.length && items[i]!.controller === owner; i++) n++;
      return n;
    }

    case 'countEvent': {
      const by = v.by ? await resolvePlayerOne(v.by, ctx) : undefined;
      const sourceUids = v.source ? (await resolveStack(v.source, ctx)).map((i) => i.uid) : undefined;
      let n = 0;
      for (const ev of s.events) {
        if (ev.kind !== v.event) continue;
        if (!inScope(ev, ctx, v.scope)) continue;
        // by は「そのイベントの主体」。受けた側/引いた本人/持ち主のこと。
        if (by && ev.player !== by) continue;
        if (sourceUids && (!ev.sourceUid || !sourceUids.includes(ev.sourceUid))) continue;
        if (v.tags && !v.tags.every((t) => ev.tags?.includes(t))) continue;
        if (v.weather) {
          const ws = Array.isArray(v.weather) ? v.weather : [v.weather];
          if (!ws.includes(ev.weather)) continue;
        }
        if (v.species) {
          if (!ev.species) continue;
          if (!matchSpecies(ev.species, v.species, ctx)) continue;
        }
        // 何を数えるかは measure が決める（既定値なし）。
        //   'events' … 発生回数。1イベント = 1
        //   'units'  … 数量の合計（ダメージ点数 / ミニオン体数 / ドロー枚数）
        n += v.measure === 'units' ? (ev.units ?? 1) : 1;
      }
      return n;
    }

    case 'chooseNumber': {
      const p = await resolvePlayerOne(v.chooser, ctx);
      const min = v.min === undefined ? 0 : await evalValue(v.min, ctx);
      const max = v.max === undefined ? 99 : await evalValue(v.max, ctx);
      return ctx.engine.chooser.number({ player: p, prompt: '数を選ぶ', min, max });
    }

    case 'add':
      return (await evalValue(v.a, ctx)) + (await evalValue(v.b, ctx));
    case 'sub':
      return (await evalValue(v.a, ctx)) - (await evalValue(v.b, ctx));
    case 'mul':
      return (await evalValue(v.a, ctx)) * (await evalValue(v.b, ctx));
    case 'min':
      return Math.min(await evalValue(v.a, ctx), await evalValue(v.b, ctx));
    case 'max':
      return Math.max(await evalValue(v.a, ctx), await evalValue(v.b, ctx));

    default:
      return unreachable(v, 'Value');
  }
}

function inScope(ev: GameEvent, ctx: Ctx, scope: 'turn' | 'cycle' | 'game'): boolean {
  const s = state(ctx);
  if (scope === 'game') return true;
  if (scope === 'cycle') return ev.cycle === s.cycle;
  return ev.turn === s.turn;
}

/** countMinions の species は SpeciesRef と SpeciesFilter の両方を取りうる */
export function countMinionsMatching(
  ctx: Ctx,
  player: PlayerId,
  spec: SpeciesRef | SpeciesFilter | undefined,
): number {
  const pool = state(ctx).players[player].minions;
  if (spec === undefined) return Object.values(pool).reduce((a, b) => a + b, 0);

  if (typeof spec === 'string') return pool[spec] ?? 0;
  if ('t' in spec) {
    if (spec.t === 'any') return Object.values(pool).reduce((a, b) => a + b, 0);
    if (spec.t === 'var') {
      const b = lookupOpt(ctx, spec.name);
      if (!b || b.of !== 'species') throw new BindingError(`種族の束縛 "${spec.name}" が見つからない`);
      return pool[b.value] ?? 0;
    }
    // {t:'choose'} を数える文脈は選択を伴うので evalValue 側で扱えない。
    throw new BindingError('countMinions の species に choose は使えない（let で先に選ぶこと）');
  }
  let n = 0;
  for (const [sp, cnt] of Object.entries(pool)) {
    if (matchSpecies(sp, spec, ctx)) n += cnt;
  }
  return n;
}
