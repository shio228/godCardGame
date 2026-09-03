/**
 * 標準 handler。
 *
 * 設計書 §7 の「handler に逃がしてよい」基準①（ゲームの基礎構造そのものを書き換える）
 * に該当する3枚ぶん。DSL に載せるとその概念が全カード・全処理に漏れるものだけを置く。
 *
 * | id | カード | 変えるもの |
 * |---|---|---|
 * | `sea/splitDeck` | 並列思考 | デッキの数 |
 * | `creation/stackSplit` | スタック分割 | スタックの数 |
 * | `creation/mergeDecks` | ケイオス・フォーチュン | デッキの所有 |
 *
 * `GameState.stacks[]` と `zones.deck: Pile[]` を最初から複数前提にしてあるので、
 * どれも状態の作り替えだけで済んでいる（設計書 §1⑤の投資が効いている）。
 */
import { createHandlerRegistry, pool, state, type Ctx, type HandlerParams, type HandlerRegistry } from './context';
import { RuleError } from './errors';
import { resolveZonePile } from './select';
import { nextUid, shufflePile, type Pile, type StackState } from './state';

const PLAYERS = ['P1', 'P2'] as const;

function numParam(params: HandlerParams, key: string, fallback: number): number {
  const v = params[key];
  return typeof v === 'number' ? v : fallback;
}

/**
 * 並列思考: あなたのデッキを1つ選んでシャッフルし、n等分する。
 * `peek` なら分けたそれぞれの一番上を見る。
 *
 * 「このゲーム中、あなたはカードを引く際、任意のあなたのデッキを選べる」の部分は
 * 山が2つ以上あるときに `drawCards` が引く山を選ばせる形で実現している
 * （デッキが分かれていること自体が権利になる）。
 */
async function splitDeck(ctx: Ctx, params: HandlerParams): Promise<void> {
  const s = state(ctx);
  const parts = Math.max(2, numParam(params, 'parts', 2));
  const piles = s.players[ctx.self].zones.deck;
  const source = await resolveZonePile({ zone: 'deck', owner: { t: 'self' }, pile: { t: 'choose' } }, ctx);
  shufflePile(s, source);

  const size = Math.ceil(source.length / parts);
  const chunks: Pile[] = [];
  for (let i = 0; i < source.length; i += size) chunks.push(source.slice(i, i + size));
  while (chunks.length < parts) chunks.push([]);

  const at = piles.indexOf(source);
  piles.splice(at, 1, ...chunks);

  ctx.engine.log.push({ depth: ctx.engine.depth, text: `${ctx.self} のデッキを ${chunks.length} 分割` });
  if (params.peek === true) {
    for (const [i, c] of chunks.entries()) {
      const top = c[c.length - 1];
      if (top) {
        ctx.engine.log.push({
          depth: ctx.engine.depth,
          text: `  山${i + 1} の一番上: ${pool(ctx).card(top.defId).name}`,
        });
      }
    }
  }
}

/**
 * スタック分割: このカードを最初のカードとした新しいスタックを作る。
 * `resolveFirst` なら、解決フェイズでそのスタックを先に解決する（＝ stacks の先頭に置く）。
 *
 * スタックが複数あるとき、以降は `play` がどちらに乗せるかを選ばせる。
 */
function stackSplit(ctx: Ctx, params: HandlerParams): void {
  const s = state(ctx);
  const item = ctx.item;
  if (!item) throw new RuleError('スタック分割はスタック項目に紐づいた効果でしか使えない');

  for (const st of s.stacks) {
    const i = st.items.findIndex((x) => x.uid === item.uid);
    if (i >= 0) st.items.splice(i, 1);
  }
  const created: StackState = { id: nextUid(s, 'S'), items: [item] };
  item.stackId = created.id;
  if (params.resolveFirst === true) s.stacks.unshift(created);
  else s.stacks.push(created);
  ctx.engine.log.push({ depth: ctx.engine.depth, text: `新しいスタック ${created.id} を作成` });
}

/**
 * ケイオス・フォーチュン: 戦場にある全てのデッキをリシャッフルし、以降デッキを共通にする。
 *
 * **両プレイヤーの `zones.deck[0]` が同じ配列を指す**ようにしている。
 * どちらが引いても同じ山が減るのが「共通」の意味で、`snapshot()` の
 * `structuredClone` は同一参照を同一参照のまま複製するのでスナップショットも壊れない。
 */
function mergeDecks(ctx: Ctx): void {
  const s = state(ctx);
  const shared: Pile = [];
  for (const pid of PLAYERS) {
    for (const pile of s.players[pid].zones.deck) shared.push(...pile);
  }
  shufflePile(s, shared);
  for (const pid of PLAYERS) s.players[pid].zones.deck = [shared];
  ctx.engine.log.push({ depth: ctx.engine.depth, text: `全デッキを統合（${shared.length}枚の共通デッキ）` });
}

/** エンジン既定の handler 一式 */
export function coreHandlers(): HandlerRegistry {
  const reg = createHandlerRegistry();
  reg.effect.set('sea/splitDeck', (ctx, params) => splitDeck(ctx, params));
  reg.effect.set('creation/stackSplit', (ctx, params) => stackSplit(ctx, params));
  reg.effect.set('creation/mergeDecks', (ctx) => mergeDecks(ctx));
  return reg;
}
