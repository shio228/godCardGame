/**
 * 解決エンジン本体 — `resolve(effect, ctx)` のインタプリタ。
 *
 * 効果は判別子 `t` 付きのデータ木なので、ここは巨大な switch になる。
 * 未対応のノードは黙って無視せず NotImplementedError を投げる。
 *
 * 戻り値 `EffectResult` は `bind` が参照する「その効果が何をしたか」。
 *   damage → 与えたダメージ量 / draw → 引いたカード / moveCards → 動かしたカード …
 */
import type {
  ActionRef,
  CardSel,
  DamageTag,
  Duration,
  Effect,
  PlayerSel,
  Selection,
  StackPayload,
  StackSel,
  TokenRef,
  Weather,
} from '../rules/types';
import {
  Scope,
  childScope,
  logLine,
  lookupOpt,
  pool,
  state,
  withBinding,
  type Ctx,
} from './context';
import { evalCondition } from './condition';
import { consumeWeatherPrevention } from './continuous';
import { changeLife, dealDamage } from './damage';
import { BindingError, LoopError, NotImplementedError, RuleError, unreachable } from './errors';
import { drainTriggers, emit } from './events';
import {
  entityLabel,
  itemName,
  resolveCards,
  resolvePlayerOne,
  resolvePlayers,
  resolveSpecies,
  resolveStack,
  resolveTokens,
  resolveZonePile,
  scopeItems,
} from './select';
import {
  ALL_WEATHERS,
  flipWeather,
  nextUid,
  opponentOf,
  rngInt,
  shufflePile,
  stackOf,
  weatherSide,
  type Bound,
  type CardInstance,
  type Entity,
  type Pile,
  type StackItem,
  type TokenInstance,
} from './state';
import { evalValue } from './value';

export interface EffectResult {
  /** 数値としての結果（ダメージ量・枚数・体数） */
  amount?: number;
  cards?: CardInstance[];
  items?: StackItem[];
  tokens?: TokenInstance[];
}

const EMPTY: EffectResult = {};

/**
 * 外から呼ぶ入口。効果を解決し、その過程で溜まった誘発を規約順に処理する。
 * 効果の内部から再帰的に呼ぶのは `resolve` のほう。
 */
export async function resolveTop(e: Effect, ctx: Ctx): Promise<EffectResult> {
  const r = await resolve(e, ctx);
  await drainTriggers(ctx.engine);
  return r;
}

export async function resolve(e: Effect, ctx: Ctx): Promise<EffectResult> {
  const engine = ctx.engine;
  if (++engine.steps > engine.budget) throw new LoopError('効果のステップ数が上限を超えた（無限ループの疑い）');
  if (engine.state.winner) return EMPTY;

  const s = state(ctx);

  switch (e.t) {
    // ------------------------------------------------------------
    // 原子効果
    // ------------------------------------------------------------
    case 'damage': {
      const targets = await resolveEntitiesFor(e.to, ctx);
      const times = e.times === undefined ? 1 : await evalValue(e.times, ctx);
      const tags: DamageTag[] = [...(e.tags ?? []), ...(ctx.actionTags ?? [])];
      const species = e.species ? await resolveSpecies(e.species, ctx) : undefined;
      let total = 0;
      for (let k = 0; k < times; k++) {
        for (const to of targets) {
          const amount = await evalValue(e.amount, ctx);
          const spec = {
            to: ctx.item?.redirectTo ?? to,
            amount,
            tags,
            flags: e.flags ?? {},
            dealer: ctx.self,
            ...(species ? { species } : {}),
            ...(ctx.item ? { source: ctx.item } : {}),
          };
          const r = await dealDamage(ctx, spec);
          logLine(ctx, `ダメージ ${r.dealt} → ${entityLabel(ctx, r.target)}（通った ${r.applied}）`);
          total += r.dealt;
        }
      }
      return { amount: total };
    }

    case 'heal': {
      const ps = await resolvePlayers(e.to, ctx);
      const n = await evalValue(e.amount, ctx);
      for (const p of ps) await changeLife(ctx, p, n);
      return { amount: n };
    }

    case 'loseLife': {
      const ps = await resolvePlayers(e.to, ctx);
      const n = await evalValue(e.amount, ctx);
      for (const p of ps) await changeLife(ctx, p, -n);
      return { amount: n };
    }

    case 'setLife': {
      const ps = await resolvePlayers(e.to, ctx);
      const n = await evalValue(e.amount, ctx);
      for (const p of ps) await changeLife(ctx, p, n - s.players[p].life);
      return { amount: n };
    }

    case 'draw': {
      const ps = await resolvePlayers(e.player, ctx);
      const base = await evalValue(e.count, ctx);
      const drawn: CardInstance[] = [];
      for (const p of ps) drawn.push(...(await drawCards(ctx, p, base, e.from)));
      return { cards: drawn, amount: drawn.length };
    }

    case 'discard': {
      const ps = await resolvePlayers(e.player, ctx);
      const n = await evalValue(e.count, ctx);
      const all: CardInstance[] = [];
      for (const p of ps) {
        const who = e.chooser ? await resolvePlayerOne(e.chooser, ctx) : p;
        const sel: CardSel = {
          t: 'choose',
          from: { zone: 'hand', owner: { t: 'var', name: '__discardOwner' } },
          count: n,
          chooser: { t: 'var', name: '__discardChooser' },
          ...(e.filter ? { filter: e.filter } : {}),
        };
        const c2 = withBinding(withBinding(ctx, '__discardOwner', { of: 'player', value: p }), '__discardChooser', {
          of: 'player',
          value: who,
        });
        const cards = await resolveCards(sel, c2);
        for (const c of cards) moveCardTo(ctx, c, s.players[p].zones.graveyard[0]!, 'top');
        all.push(...cards);
        await emit(ctx, {
          kind: 'discarded',
          player: p,
          units: cards.length,
          bindings: {
            count: { of: 'number', value: cards.length },
            cards: { of: 'card', value: cards },
          },
        });
      }
      return { cards: all, amount: all.length };
    }

    case 'foresee': {
      const ps = await resolvePlayers(e.player, ctx);
      const n = await evalValue(e.count, ctx);
      const moved: CardInstance[] = [];
      for (const p of ps) {
        const deck = s.players[p].zones.deck[0]!;
        const taken = deck.splice(Math.max(0, deck.length - n), n).reverse();
        s.players[p].zones.foresight[0]!.push(...taken);
        moved.push(...taken);
        await emit(ctx, {
          kind: 'foreseen',
          player: p,
          units: taken.length,
          bindings: {
            count: { of: 'number', value: taken.length },
            cards: { of: 'card', value: taken },
          },
        });
      }
      return { cards: moved, amount: moved.length };
    }

    case 'reveal': {
      const cards = await resolveCards(e.cards, ctx);
      logLine(ctx, `公開: ${cards.map((c) => pool(ctx).card(c.defId).name).join(', ')}`);
      return { cards };
    }

    case 'moveCards': {
      const cards = await resolveCards(e.cards, ctx);
      const dest = await resolveZonePile(e.to, ctx);
      const owner = await resolvePlayerOne(e.to.owner, ctx);
      let ordered = cards;
      if (e.order === 'random') {
        ordered = [...cards];
        for (let i = ordered.length - 1; i > 0; i--) {
          const j = rngInt(s, i + 1);
          const a = ordered[i]!;
          ordered[i] = ordered[j]!;
          ordered[j] = a;
        }
      } else if (e.order === 'choose' && cards.length > 1) {
        ordered = await ctx.engine.chooser.order<CardInstance>({
          kind: 'card',
          player: ctx.self,
          prompt: '置く順を決める',
          options: cards.map((c) => ({ value: c, label: pool(ctx).card(c.defId).name })),
        });
      }
      for (const c of ordered) {
        c.owner = c.owner; // 所有者は変えない（ゾーンの持ち主だけが変わる）
        moveCardTo(ctx, c, dest, e.position ?? 'top');
      }
      if (e.reveal) logLine(ctx, `公開して移動: ${ordered.length}枚 → ${owner}の${e.to.zone}`);
      return { cards: ordered, amount: ordered.length };
    }

    case 'reorderCards': {
      const cards = await resolveCards(e.cards, ctx);
      if (cards.length <= 1) return { cards };
      const by = e.by ? await resolvePlayerOne(e.by, ctx) : ctx.self;
      const ordered = await ctx.engine.chooser.order<CardInstance>({
        kind: 'card',
        player: by,
        prompt: '並べ替える',
        options: cards.map((c) => ({ value: c, label: pool(ctx).card(c.defId).name })),
      });
      // 元の位置に新しい順で書き戻す
      const pileOf = new Map<CardInstance, { pile: Pile; index: number }>();
      for (const c of cards) {
        const loc = locateCard(ctx, c);
        if (loc) pileOf.set(c, loc);
      }
      const slots = [...pileOf.values()].sort((a, b) => a.index - b.index);
      slots.forEach((slot, i) => {
        slot.pile[slot.index] = ordered[i]!;
      });
      return { cards: ordered };
    }

    case 'shuffle': {
      for (const p of await resolvePlayers(e.of.owner, ctx)) {
        for (const pile of s.players[p].zones[e.of.zone]) shufflePile(s, pile);
      }
      return EMPTY;
    }

    case 'splitDeck': {
      const owner = await resolvePlayerOne(e.of.owner, ctx);
      const parts = await evalValue(e.parts, ctx);
      const merged = s.players[owner].zones[e.of.zone].flat();
      const size = Math.ceil(merged.length / parts);
      const piles: Pile[] = [];
      for (let i = 0; i < parts; i++) piles.push(merged.slice(i * size, (i + 1) * size));
      s.players[owner].zones[e.of.zone] = piles;
      logLine(ctx, `${owner}の${e.of.zone}を${parts}つに分割`);
      return EMPTY;
    }

    // ------------------------------------------------------------
    // スタック操作
    // ------------------------------------------------------------
    case 'reorderStack': {
      const items = await resolveStack(e.items, ctx);
      if (items.length <= 1) return { items };
      const st = stackOf(s, ctx.stackId ?? ctx.item?.stackId);
      const idxs = items.map((it) => st.items.findIndex((x) => x.uid === it.uid)).filter((i) => i >= 0).sort((a, b) => a - b);
      let ordered: StackItem[];
      if (e.mode === 'random') {
        ordered = [...items];
        for (let i = ordered.length - 1; i > 0; i--) {
          const j = rngInt(s, i + 1);
          const a = ordered[i]!;
          ordered[i] = ordered[j]!;
          ordered[j] = a;
        }
      } else if (e.mode === 'swap') {
        ordered = [...items].reverse();
      } else {
        const by = e.by ? await resolvePlayerOne(e.by, ctx) : ctx.self;
        ordered = await ctx.engine.chooser.order<StackItem>({
          kind: 'stack',
          player: by,
          prompt: 'スタックの順を決める',
          options: items.map((it) => ({ value: it, label: itemName(ctx, it) })),
        });
      }
      idxs.forEach((slot, i) => {
        st.items[slot] = ordered[i]!;
      });
      for (const it of st.items) {
        await emit(ctx, { kind: 'reordered', itemUid: it.uid, player: it.controller });
      }
      return { items: ordered };
    }

    case 'counterStack': {
      const items = await resolveStack(e.target, ctx);
      for (const it of items) {
        removeFromStack(ctx, it);
        if (it.card) s.players[it.card.owner].zones.graveyard[0]!.push(it.card);
        await emit(ctx, { kind: 'countered', itemUid: it.uid, player: it.controller });
      }
      return { items };
    }

    case 'moveStackItem': {
      const items = await resolveStack(e.item, ctx);
      const st = stackOf(s, ctx.stackId ?? ctx.item?.stackId);
      for (const it of items) {
        if (it.immovable) {
          logLine(ctx, `${itemName(ctx, it)} は位置を変えられない`);
          continue;
        }
        const cur = st.items.findIndex((x) => x.uid === it.uid);
        if (cur < 0) continue;
        st.items.splice(cur, 1);
        let at: number;
        if (e.to === 'top') at = st.items.length;
        else if (e.to === 'bottom') at = 0;
        else if (e.to === 'anywhere') {
          const picked = await ctx.engine.chooser.select<number>({
            kind: 'position',
            player: e.by ? await resolvePlayerOne(e.by, ctx) : ctx.self,
            prompt: `${itemName(ctx, it)} を置く位置`,
            options: st.items.map((x, i) => ({ value: i, label: `${itemName(ctx, x)} の下` })).concat([
              { value: st.items.length, label: '一番上' },
            ]),
            min: 1,
            max: 1,
          });
          at = picked[0] ?? st.items.length;
        } else {
          const rel = e.relativeTo ? (await resolveStack(e.relativeTo, ctx))[0] : undefined;
          const ri = rel ? st.items.findIndex((x) => x.uid === rel.uid) : -1;
          if (ri < 0) at = st.items.length;
          else if (e.to === 'above') at = ri + 1;
          else if (e.to === 'below') at = ri;
          else {
            // 'replace': そこにあるものと入れ替える
            at = ri;
            st.items.splice(ri, 1);
          }
        }
        st.items.splice(at, 0, it);
        await emit(ctx, { kind: 'reordered', itemUid: it.uid, player: it.controller });
      }
      return { items };
    }

    case 'moveStackToZone': {
      const items = await resolveStack(e.item, ctx);
      const dest = await resolveZonePile(e.to, ctx);
      for (const it of items) {
        removeFromStack(ctx, it);
        if (it.card) dest.push(it.card);
        await emit(ctx, {
          kind: e.to.zone === 'hand' ? 'bounced' : 'countered',
          itemUid: it.uid,
          player: it.controller,
        });
      }
      return { items };
    }

    case 'addToStack': {
      const times = e.times === undefined ? 1 : await evalValue(e.times, ctx);
      const made: StackItem[] = [];
      for (let k = 0; k < times; k++) made.push(...(await pushPayload(ctx, e.payload, e.position, e.relativeTo)));
      if (e.immediate) {
        for (const it of made) await resolveStackItem(ctx, it, false);
      }
      return { items: made };
    }

    case 'resolveStack': {
      const items = await resolveStack(e.items, ctx);
      for (const it of items) await resolveStackItem(ctx, it, e.keepOnStack === true);
      return { items };
    }

    case 'redirect': {
      const items = await resolveStack(e.item, ctx);
      const to = (await resolveEntitiesFor(e.to, ctx))[0];
      if (!to) throw new RuleError('redirect の着弾先が決まらない');
      for (const it of items) it.redirectTo = to;
      return { items };
    }

    case 'addCounter':
    case 'removeCounter': {
      const items = await resolveStack(e.on, ctx);
      const n = await evalValue(e.amount, ctx);
      const delta = e.t === 'addCounter' ? n : -n;
      for (const it of items) {
        const before = it.counters[e.kind] ?? 0;
        const after = before + delta;
        it.counters[e.kind] = after;
        await emit(ctx, {
          kind: 'counterChanged',
          itemUid: it.uid,
          player: it.controller,
          units: Math.abs(delta),
          bindings: {
            count: { of: 'number', value: after },
            delta: { of: 'number', value: delta },
            source: { of: 'stack', value: [it] },
          },
        });
      }
      return { items, amount: Math.abs(delta) };
    }

    // ------------------------------------------------------------
    // NamedAction
    // ------------------------------------------------------------
    case 'performAction': {
      const times = e.times === undefined ? 1 : await evalValue(e.times, ctx);
      let total = 0;
      const used: string[] = [];
      for (let k = 0; k < times; k++) {
        const id = await resolveActionRef(e.action, ctx, e.distinct ? used : undefined);
        used.push(id);
        const def = pool(ctx).action(id);
        logLine(ctx, `${def.name} を行う`);
        const sub: Ctx = { ...childScope(ctx), actionTags: [...(ctx.actionTags ?? []), ...(def.tags ?? [])] };
        const r = await resolve(def.effect, sub);
        total += r.amount ?? 0;
      }
      return { amount: total };
    }

    // ------------------------------------------------------------
    // トークン / ミニオン
    // ------------------------------------------------------------
    case 'createToken': {
      const owner = e.owner ? await resolvePlayerOne(e.owner, ctx) : ctx.self;
      const count = e.count === undefined ? 1 : await evalValue(e.count, ctx);
      const made: TokenInstance[] = [];
      for (let k = 0; k < count; k++) {
        const defId = await resolveTokenRef(e.token, ctx, owner);
        const tk: TokenInstance = {
          uid: nextUid(s, 'TK'),
          defId,
          owner,
          equipped: e.equip !== false,
          ...(e.mark ? { mark: e.mark } : {}),
        };
        s.players[owner].tokens.push(tk);
        made.push(tk);
        await emit(ctx, {
          kind: 'tokenCreated',
          player: owner,
          units: 1,
          bindings: { token: { of: 'token', value: [tk] } },
        });
      }
      return { tokens: made, amount: made.length };
    }

    case 'destroyToken': {
      const tokens = await resolveTokens(e.tokens, ctx);
      for (const tk of tokens) {
        const arr = s.players[tk.owner].tokens;
        const i = arr.findIndex((x) => x.uid === tk.uid);
        if (i >= 0) arr.splice(i, 1);
      }
      return { tokens, amount: tokens.length };
    }

    case 'createMinion': {
      const owner = e.owner ? await resolvePlayerOne(e.owner, ctx) : ctx.self;
      const sp = await resolveSpecies(e.species, ctx);
      const n = await evalValue(e.count, ctx);
      if (n <= 0) return { amount: 0 };
      s.players[owner].minions[sp] = (s.players[owner].minions[sp] ?? 0) + n;
      await emit(ctx, {
        kind: 'minionCreated',
        player: owner,
        species: sp,
        units: n,
        bindings: { species: { of: 'species', value: sp }, count: { of: 'number', value: n } },
      });
      return { amount: n };
    }

    case 'sacrificeMinion': {
      const owner = e.owner ? await resolvePlayerOne(e.owner, ctx) : ctx.self;
      const sp = await resolveSpecies(e.species, ctx);
      const want = await evalValue(e.count, ctx);
      const have = s.players[owner].minions[sp] ?? 0;
      const n = Math.min(want, have);
      if (n <= 0) return { amount: 0 };
      s.players[owner].minions[sp] = have - n;
      const bindings = { species: { of: 'species' as const, value: sp }, count: { of: 'number' as const, value: n } };
      await emit(ctx, { kind: 'minionSacrificed', player: owner, species: sp, units: n, bindings });
      await emit(ctx, { kind: 'minionDied', player: owner, species: sp, units: n, bindings });
      return { amount: n };
    }

    // ------------------------------------------------------------
    // 状態
    // ------------------------------------------------------------
    case 'gainStatus': {
      const ps = await resolvePlayers(e.player, ctx);
      let n = await evalValue(e.amount, ctx);
      if (e.capFromThisSource !== undefined && ctx.item) {
        const cap = await evalValue(e.capFromThisSource, ctx);
        const key = `${ctx.item.uid}:${e.kind}`;
        for (const p of ps) {
          const already = s.players[p].statusGrants
            .filter((g) => g.sourceKey === key)
            .reduce((a, b) => a + b.amount, 0);
          n = Math.min(n, Math.max(0, cap - already));
        }
      }
      if (n <= 0) return { amount: 0 };
      for (const p of ps) {
        s.players[p].status[e.kind] += n;
        s.players[p].statusGrants.push({
          kind: e.kind,
          amount: n,
          duration: e.duration ?? 'thisTurn',
          ...(ctx.item ? { sourceUid: ctx.item.uid, sourceKey: `${ctx.item.uid}:${e.kind}` } : {}),
        });
      }
      return { amount: n };
    }

    case 'addPlayerCounter': {
      const ps = await resolvePlayers(e.to, ctx);
      const n = await evalValue(e.amount, ctx);
      for (const p of ps) s.players[p].counters[e.kind] = (s.players[p].counters[e.kind] ?? 0) + n;
      return { amount: n };
    }

    case 'setWeather': {
      const from = s.weather;
      let next: Weather;
      if (typeof e.weather === 'string') {
        next = e.weather;
      } else if (e.weather.t === 'random') {
        const cands = ALL_WEATHERS.filter((w) => !e.weather || typeof e.weather === 'string' || !('side' in e.weather) || !e.weather.side || weatherSide(w) === e.weather.side);
        next = cands[rngInt(s, cands.length)] ?? 'calm';
      } else {
        const side = e.weather.side;
        const cands = ALL_WEATHERS.filter((w) => !side || weatherSide(w) === side);
        const picked = await ctx.engine.chooser.select<Weather>({
          kind: 'weather',
          player: ctx.self,
          prompt: '天候を選ぶ',
          options: cands.map((w) => ({ value: w, label: w })),
          min: 1,
          max: 1,
        });
        next = picked[0] ?? 'calm';
      }
      if (next === from && e.ifAlreadyThen) next = e.ifAlreadyThen;
      if (e.flipToBack) next = flipWeather(next);
      if (s.apocalypse) {
        logLine(ctx, '終末なので天候は変更されない');
        return EMPTY;
      }
      if (await consumeWeatherPrevention(ctx.engine, ctx.self)) {
        logLine(ctx, '天候変更が打ち消された');
        return EMPTY;
      }
      s.weather = next;
      await emit(ctx, {
        kind: 'weatherChanged',
        player: ctx.self,
        bindings: { from: { of: 'number', value: 0 }, to: { of: 'number', value: 0 } },
      });
      logLine(ctx, `天候: ${from} → ${next}`);
      return EMPTY;
    }

    case 'grantContinuous': {
      const owner = e.to ? await resolvePlayerOne(e.to, ctx) : ctx.self;
      s.continuous.push({
        id: nextUid(s, 'CM'),
        mod: e.mod,
        duration: e.duration,
        controller: owner,
        ...(ctx.item ? { sourceUid: ctx.item.uid } : {}),
        ...(e.cond ? { cond: e.cond } : {}),
        ...(e.onceOnly ? { onceOnly: true } : {}),
      });
      return EMPTY;
    }

    case 'grantTrigger': {
      const owner = e.to ? await resolvePlayerOne(e.to, ctx) : ctx.self;
      s.grantedTriggers.push({
        id: nextUid(s, 'GT'),
        trigger: e.trigger,
        duration: e.duration,
        controller: owner,
        ...(ctx.item ? { sourceUid: ctx.item.uid } : {}),
        ...(e.onceOnly ? { onceOnly: true } : {}),
      });
      return EMPTY;
    }

    case 'snapshot': {
      if (!ctx.item) throw new RuleError('snapshot はスタック項目に紐づいた効果でしか使えない');
      const b: Bound =
        e.value !== undefined
          ? { of: 'number', value: await evalValue(e.value, ctx) }
          : await evalSelection(e.select!, ctx);
      ctx.item.snapshots[e.name] = b;
      return EMPTY;
    }

    case 'revealObjective': {
      const ps = await resolvePlayers(e.player, ctx);
      const { revealObjectiveAt, emitObjectiveRevealed } = await import('./objectives');
      for (const p of ps) {
        const which = e.which === undefined ? 0 : await evalValue(e.which, ctx);
        const o = revealObjectiveAt(ctx.engine, p, which);
        // 先攻後攻はサイクル開始の公開でしか動かないので、ここでは決め直さない
        if (o) await emitObjectiveRevealed(ctx.engine, p, o.id);
      }
      return EMPTY;
    }

    case 'win': {
      const p = await resolvePlayerOne(e.player, ctx);
      s.winner = p;
      logLine(ctx, `${p} の勝利`);
      return EMPTY;
    }

    case 'lose': {
      const p = await resolvePlayerOne(e.player, ctx);
      s.winner = opponentOf(p);
      return EMPTY;
    }

    // ------------------------------------------------------------
    // 制御構造
    // ------------------------------------------------------------
    case 'seq': {
      let last: EffectResult = EMPTY;
      for (const child of e.of) last = await resolve(child, ctx);
      return last;
    }

    case 'repeat': {
      const n = await evalValue(e.count, ctx);
      let total = 0;
      for (let k = 0; k < n; k++) {
        const r = await resolve(e.body, ctx);
        total += r.amount ?? 0;
      }
      return { amount: total };
    }

    case 'if':
      if (await evalCondition(e.cond, ctx)) return resolve(e.then, ctx);
      return e.else ? resolve(e.else, ctx) : EMPTY;

    case 'forEach': {
      const items = await resolveForEach(e.of, ctx);
      let total = 0;
      for (const b of items) {
        const r = await resolve(e.body, withBinding(ctx, e.as, b));
        total += r.amount ?? 0;
      }
      return { amount: total };
    }

    case 'optional': {
      const who = await resolvePlayerOne(e.chooser, ctx);
      const ok = await ctx.engine.chooser.confirm({ player: who, prompt: '任意効果を使う？' });
      return ok ? resolve(e.body, ctx) : EMPTY;
    }

    case 'modal': {
      const who = await resolvePlayerOne(e.chooser, ctx);
      const n = e.count === undefined ? 1 : await evalValue(e.count, ctx);
      const picked = await ctx.engine.chooser.select<number>({
        kind: 'mode',
        player: who,
        prompt: `モードを${n}つ選ぶ`,
        options: e.modes.map((m, i) => ({ value: i, label: m.text })),
        min: Math.min(n, e.modes.length),
        max: Math.min(n, e.modes.length),
      });
      let total = 0;
      for (const i of picked) {
        const m = e.modes[i];
        if (!m) continue;
        const r = await resolve(m.effect, ctx);
        total += r.amount ?? 0;
      }
      return { amount: total };
    }

    case 'while': {
      const who = await resolvePlayerOne(e.chooser, ctx);
      const max = e.max === undefined ? 100 : await evalValue(e.max, ctx);
      let total = 0;
      for (let k = 0; k < max; k++) {
        const ok = await ctx.engine.chooser.confirm({ player: who, prompt: '繰り返す？' });
        if (!ok) break;
        if (e.cost) {
          const paid = await resolve(e.cost, ctx);
          // 支払えなかった（何も動かなかった）なら打ち切る
          if ((paid.amount ?? 0) === 0 && (paid.cards?.length ?? 0) === 0) break;
        }
        const r = await resolve(e.body, ctx);
        total += r.amount ?? 0;
      }
      return { amount: total };
    }

    case 'bind': {
      const r = await resolve(e.of, ctx);
      const b: Bound = r.cards
        ? { of: 'card', value: r.cards }
        : r.items
          ? { of: 'stack', value: r.items }
          : r.tokens
            ? { of: 'token', value: r.tokens }
            : { of: 'number', value: r.amount ?? 0 };
      // 数値としても読めるように、集合の場合は要素数が boundToNumber で得られる
      return resolve(e.then, withBinding(ctx, e.name, b));
    }

    case 'let': {
      const b = await evalSelection(e.select, ctx);
      return resolve(e.then, withBinding(ctx, e.name, b));
    }

    case 'nothing':
      return EMPTY;

    case 'handler': {
      const fn = ctx.engine.handlers.effect.get(e.id);
      if (!fn) throw new NotImplementedError(`handler "${e.id}" が登録されていない`, e);
      await fn(ctx, e.params ?? {});
      return EMPTY;
    }

    default:
      return unreachable(e, 'Effect');
  }
}

// ============================================================
// 補助
// ============================================================

async function resolveEntitiesFor(sel: Parameters<typeof import('./select').resolveEntities>[0], ctx: Ctx) {
  const { resolveEntities } = await import('./select');
  return resolveEntities(sel, ctx);
}

/** Selection（let / snapshot の select）を束縛値にする */
async function evalSelection(sel: Selection, ctx: Ctx): Promise<Bound> {
  switch (sel.of) {
    case 'number':
      return { of: 'number', value: await evalValue(sel.value, ctx) };
    case 'player':
      return { of: 'player', value: await resolvePlayerOne(sel.sel, ctx) };
    case 'species':
      return { of: 'species', value: await resolveSpecies(sel.sel, ctx) };
    case 'stack':
      return { of: 'stack', value: await resolveStack(sel.sel, ctx) };
    case 'card':
      return { of: 'card', value: await resolveCards(sel.sel, ctx) };
    case 'token':
      return { of: 'token', value: await resolveTokens(sel.sel, ctx) };
    case 'entity': {
      const es = await resolveEntitiesFor(sel.sel, ctx);
      const first = es[0];
      if (!first) throw new RuleError('entity を選べなかった');
      return { of: 'entity', value: first };
    }
    default:
      return unreachable(sel, 'Selection');
  }
}

const PLAYER_TS = ['self', 'opponent', 'each', 'controllerOf'];

/** forEach の of は StackSel | CardSel | PlayerSel の3種を取りうる */
async function resolveForEach(of: StackSel | CardSel | PlayerSel, ctx: Ctx): Promise<Bound[]> {
  if (PLAYER_TS.includes(of.t)) {
    const ps = await resolvePlayers(of as PlayerSel, ctx);
    return ps.map((p) => ({ of: 'player', value: p }));
  }
  if ('from' in of) {
    const cards = await resolveCards(of as CardSel, ctx);
    return cards.map((c) => ({ of: 'card', value: [c] }));
  }
  if (of.t === 'var') {
    const b = lookupOpt(ctx, of.name);
    if (!b) throw new BindingError(`束縛 "${of.name}" が見つからない`);
    if (b.of === 'card') return b.value.map((c) => ({ of: 'card', value: [c] }));
    if (b.of === 'stack') return b.value.map((i) => ({ of: 'stack', value: [i] }));
    if (b.of === 'token') return b.value.map((t) => ({ of: 'token', value: [t] }));
    return [b];
  }
  const items = await resolveStack(of as StackSel, ctx);
  return items.map((i) => ({ of: 'stack', value: [i] }));
}

async function resolveActionRef(ref: ActionRef, ctx: Ctx, exclude?: string[]): Promise<string> {
  if (typeof ref === 'string') return ref;
  if (ref.t === 'var') {
    const b = lookupOpt(ctx, ref.name);
    if (!b || b.of !== 'species') throw new BindingError(`アクションの束縛 "${ref.name}" が見つからない`);
    return b.value;
  }
  let ids = pool(ctx).group(ref.group);
  if (exclude && exclude.length > 0) {
    const left = ids.filter((i) => !exclude.includes(i));
    if (left.length > 0) ids = left;
  }
  if (ids.length === 1) return ids[0]!;
  const who = ref.chooser ? await resolvePlayerOne(ref.chooser, ctx) : ctx.self;
  const picked = await ctx.engine.chooser.select<string>({
    kind: 'action',
    player: who,
    prompt: 'どれを行う？',
    options: ids.map((id) => ({ value: id, label: pool(ctx).action(id).name })),
    min: 1,
    max: 1,
  });
  const id = picked[0];
  if (!id) throw new RuleError('アクションが選ばれなかった');
  return id;
}

async function resolveTokenRef(ref: TokenRef, ctx: Ctx, owner: string): Promise<string> {
  if (typeof ref === 'string') return ref;
  if (ref.t === 'var') {
    const b = lookupOpt(ctx, ref.name);
    if (!b || b.of !== 'token') throw new BindingError(`トークンの束縛 "${ref.name}" が見つからない`);
    const first = b.value[0];
    if (!first) throw new RuleError('トークンの束縛が空');
    return first.defId;
  }
  const god = pool(ctx).god(state(ctx).players[owner as 'P1' | 'P2'].god);
  let ids = god?.tokens ?? [...pool(ctx).tokens.keys()];
  if (ref.kind) {
    const ks = Array.isArray(ref.kind) ? ref.kind : [ref.kind];
    ids = ids.filter((id) => ks.includes(pool(ctx).token(id).kind));
  }
  if (ref.excludeRelic) ids = ids.filter((id) => pool(ctx).token(id).kind !== 'relic');
  if (ref.excludeEquipped) {
    const owned = state(ctx).players[owner as 'P1' | 'P2'].tokens.filter((t) => t.equipped).map((t) => t.defId);
    ids = ids.filter((id) => !owned.includes(id));
  }
  if (ids.length === 0) throw new RuleError('生成できるトークンがない');
  if (ids.length === 1) return ids[0]!;
  const who = ref.chooser ? await resolvePlayerOne(ref.chooser, ctx) : ctx.self;
  const picked = await ctx.engine.chooser.select<string>({
    kind: 'token',
    player: who,
    prompt: '生成するトークンを選ぶ',
    options: ids.map((id) => ({ value: id, label: pool(ctx).token(id).name })),
    min: 1,
    max: 1,
  });
  return picked[0] ?? ids[0]!;
}

// ------------------------------------------------------------
// カードの移動
// ------------------------------------------------------------

export function locateCard(ctx: Ctx, c: CardInstance): { pile: Pile; index: number } | undefined {
  const s = state(ctx);
  for (const pid of ['P1', 'P2'] as const) {
    for (const piles of Object.values(s.players[pid].zones)) {
      for (const pile of piles) {
        const i = pile.findIndex((x) => x.uid === c.uid);
        if (i >= 0) return { pile, index: i };
      }
    }
  }
  return undefined;
}

export function moveCardTo(ctx: Ctx, c: CardInstance, dest: Pile, position: 'top' | 'bottom'): void {
  const loc = locateCard(ctx, c);
  if (loc) loc.pile.splice(loc.index, 1);
  if (position === 'bottom') dest.unshift(c);
  else dest.push(c);
}

/**
 * ドロー。置換効果（drawDelta）を必ず通す。
 * 山札が足りない場合は引き切りペナルティ（不足1枚につき「30点のダメージを受ける」）を
 * スタックに積む — 対象に取れる効果として扱うため、直接ダメージにはしない。
 */
async function drawCards(
  ctx: Ctx,
  player: 'P1' | 'P2',
  count: number,
  from?: { zone: 'deck' | 'hand' | 'graveyard' | 'foresight' | 'exile' | 'field' | 'staging'; owner: PlayerSel },
): Promise<CardInstance[]> {
  const s = state(ctx);
  const { activeMods, modCtx } = await import('./continuous');
  let n = count;
  for (const am of await activeMods(ctx.engine, 'drawDelta')) {
    const who = await resolvePlayers(am.mod.who, modCtx(ctx.engine, am));
    if (!who.includes(player)) continue;
    n += await evalValue(am.mod.amount, modCtx(ctx.engine, am));
  }
  n = Math.max(0, n);

  const zone = from?.zone ?? 'deck';
  const pile = s.players[player].zones[zone][0]!;
  const taken: CardInstance[] = [];
  for (let k = 0; k < n; k++) {
    const c = pile.pop();
    if (!c) break;
    taken.push(c);
    s.players[player].zones.hand[0]!.push(c);
  }

  const missing = n - taken.length;
  if (missing > 0) {
    logLine(ctx, `${player} は ${missing} 枚引けなかった（引き切りペナルティ）`);
    for (let k = 0; k < missing; k++) {
      await pushPayload(
        ctx,
        {
          t: 'effect',
          text: 'あなたは30点のダメージを受ける',
          effect: {
            t: 'damage',
            to: { t: 'player', who: { t: 'self' } },
            amount: 30,
            tags: ['system'],
          },
        },
        'top',
        undefined,
        player,
      );
    }
  }

  await emit(ctx, {
    kind: 'drawn',
    player,
    units: taken.length,
    bindings: {
      count: { of: 'number', value: taken.length },
      cards: { of: 'card', value: taken },
    },
  });
  return taken;
}

// ------------------------------------------------------------
// スタックへの追加と解決
// ------------------------------------------------------------

export async function pushPayload(
  ctx: Ctx,
  payload: StackPayload,
  position: 'top' | 'above' | 'below' | undefined,
  relativeTo: StackSel | undefined,
  controllerOverride?: 'P1' | 'P2',
): Promise<StackItem[]> {
  const s = state(ctx);
  const st = stackOf(s, ctx.stackId ?? ctx.item?.stackId);
  const controller = controllerOverride ?? ctx.self;
  const made: StackItem[] = [];

  const base = () => ({
    uid: nextUid(s, 'IT'),
    controller,
    stackId: st.id,
    counters: {} as Record<string, number>,
    snapshots: {} as Record<string, Bound>,
    immovable: false,
  });

  if (payload.t === 'effect') {
    made.push({ ...base(), kind: 'effect', effect: payload.effect, text: payload.text });
  } else if (payload.t === 'action') {
    const id = await resolveActionRef(payload.action, ctx);
    made.push({ ...base(), kind: 'action', actionId: id });
  } else {
    const cards = await resolveCards(payload.card, ctx);
    for (const c of cards) {
      const loc = locateCard(ctx, c);
      if (loc) loc.pile.splice(loc.index, 1);
      const def = pool(ctx).card(c.defId);
      made.push({ ...base(), kind: 'card', card: c, immovable: def.immovable === true });
    }
  }

  let at = st.items.length;
  if (position === 'above' || position === 'below') {
    const rel = relativeTo ? (await resolveStack(relativeTo, ctx))[0] : undefined;
    const ri = rel ? st.items.findIndex((x) => x.uid === rel.uid) : -1;
    if (ri >= 0) at = position === 'above' ? ri + 1 : ri;
  }
  st.items.splice(at, 0, ...made);

  for (const it of made) {
    await applyOnStackStatics(ctx, it);
    await emit(ctx, { kind: 'placedOnStack', itemUid: it.uid, player: it.controller });
  }
  return made;
}

/**
 * NamedAction が「常在」だけを持つ場合（防御指令）、その効果は**解決時ではなく
 * スタックに乗った時点**から働かなければ意味がない（duration:'whileOnStack' なので
 * 解決した瞬間に消えてしまう）。
 * そこで、効果が whileOnStack の grantContinuous / grantTrigger だけで構成されている
 * アクション項目に限り、配置時にその付与を実行する。
 *
 * ※ 企画側の確認事項: 「常在を持つ NamedAction は乗せた時点で働き始める」という理解で
 *    合っているか（設計書 §4 の3分解をアクションにも適用した形）。
 */
async function applyOnStackStatics(ctx: Ctx, it: StackItem): Promise<void> {
  if (it.kind !== 'action' || !it.actionId) return;
  const def = pool(ctx).action(it.actionId);
  if (!isPureWhileOnStackGrant(def.effect)) return;
  const sub: Ctx = { engine: ctx.engine, self: it.controller, item: it, stackId: it.stackId, vars: new Scope() };
  await resolve(def.effect, sub);
}

function isPureWhileOnStackGrant(e: Effect): boolean {
  if (e.t === 'grantContinuous' || e.t === 'grantTrigger') return e.duration === 'whileOnStack';
  if (e.t === 'seq') return e.of.length > 0 && e.of.every(isPureWhileOnStackGrant);
  return false;
}

/**
 * スタック項目1つを解決する。
 * カードなら onResolve、NamedAction ならその効果、生成された効果ならその効果。
 */
export async function resolveStackItem(ctx: Ctx, it: StackItem, keepOnStack: boolean): Promise<void> {
  const s = state(ctx);
  // 解決中の項目を再び解決しない（自己再帰の防止）
  if (ctx.engine.resolving.has(it.uid)) return;
  ctx.engine.resolving.add(it.uid);
  try {
    await resolveStackItemInner(ctx, it, keepOnStack);
  } finally {
    ctx.engine.resolving.delete(it.uid);
  }
}

async function resolveStackItemInner(ctx: Ctx, it: StackItem, keepOnStack: boolean): Promise<void> {
  const s = state(ctx);
  const sub: Ctx = {
    engine: ctx.engine,
    self: it.controller,
    item: it,
    stackId: it.stackId,
    // 項目の解決は独立した束縛スコープで始める（外側の let を持ち込まない）
    vars: new Scope(),
  };

  await emit(sub, { kind: 'resolving', itemUid: it.uid, player: it.controller });
  if (s.winner) return;

  if (it.kind === 'card' && it.card) {
    const def = pool(ctx).card(it.card.defId);
    for (const ab of def.abilities) {
      if (ab.kind === 'onResolve') await resolve(ab.effect, sub);
    }
  } else if (it.kind === 'action' && it.actionId) {
    const def = pool(ctx).action(it.actionId);
    await resolve(def.effect, { ...sub, actionTags: def.tags ?? [] });
  } else if (it.effect) {
    await resolve(it.effect, sub);
  }

  await emit(sub, { kind: 'resolved', itemUid: it.uid, player: it.controller });

  if (!keepOnStack) {
    removeFromStack(ctx, it);
    if (it.card) s.players[it.card.owner].zones.graveyard[0]!.push(it.card);
  }
}

export function removeFromStack(ctx: Ctx, it: StackItem): void {
  for (const st of state(ctx).stacks) {
    const i = st.items.findIndex((x) => x.uid === it.uid);
    if (i >= 0) {
      st.items.splice(i, 1);
      return;
    }
  }
}

export { scopeItems };
export type { Entity, Duration };
