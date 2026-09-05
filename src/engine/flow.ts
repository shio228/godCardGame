/**
 * ゲーム進行。
 *
 * 企画書「基本ルール」のフェイズ定義をそのまま関数にしている:
 *   ①サイクル開始 `startCycle` → ②ドロー `drawPhase` → ③スタック `stackPhase`
 *   → ④順番確定 `orderPhase` → ⑤解決 `resolvePhase` → ⑥終了 `endTurn` / `endCycle`
 *
 * `runGame` がこれを1試合分回す。1サイクル = 1ターンで、両者が同じスタックに
 * 交互にカードを積む構造なので「手番が2回ある」形にはならない。
 */
import type { CardDef, CardPool, ContinuousMod, Effect, God, Keyword, PlayerId, StackFilter } from '../rules/types';
import { AutoChooser, type Chooser } from './chooser';
import { Scope, logAction, type Ctx, type Engine, type HandlerRegistry } from './context';
import { coreHandlers } from './handlers';
import { evalCondition } from './condition';
import { evalValue } from './value';
import { activeMods, modCtx, type ActiveMod } from './continuous';
import { drawCards, pushPayload, resolve, resolveStackItem } from './effects';
import { drainTriggers, emit, consumeLimit, limitAvailable } from './events';
import { NotImplementedError, RuleError } from './errors';
import { PoolIndex } from './pool';
import { revealPhase, setupObjectives } from './objectives';
import { matchStack, resolveEntities, resolvePlayers } from './select';
import { DECK_MAX, DECK_MIN, HAND_LIMIT, MAX_COPIES } from '../rules/limits';
import { applyWeatherNegation } from './weather';
import {
  createState,
  nextUid,
  opponentOf,
  setWinner,
  shufflePile,
  stackOf,
  totalMinions,
  turnOrder,
  type CardInstance,
  type CreateStateOptions,
  type GameState,
  type StackItem,
  type StackState,
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
    handlers: opts.handlers ?? coreHandlers(),
    pending: [],
    log: [],
    depth: 0,
    budget: opts.budget ?? 10000,
    steps: 0,
    resolving: new Set<string>(),
    targetCheckDepth: 0,
  };
}

/** スタックに紐づかない、プレイヤー視点の ctx */
export function topCtx(engine: Engine, self: PlayerId): Ctx {
  return { engine, self, vars: new Scope() };
}

const PLAYERS: PlayerId[] = ['P1', 'P2'];

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
// ゲーム開始（企画書「基本ルール」）
// ============================================================

// デッキ構築と手札の上限は `src/rules/limits.ts`（企画書「基本ルール」の数値）。
// ここから使うぶんを import しつつ、これまでどおり flow から引けるように再exportする
export { DECK_MIN, DECK_MAX, MAX_COPIES, HAND_LIMIT, OBJECTIVE_MIN } from '../rules/limits';

/**
 * サイクル別のドロー枚数（企画書「基本ドロー枚数」）。
 * 0サイクル目の7枚が初期手札。累計は 7/12/18/25/30 で、
 * **4サイクル目に30枚デッキを引き切る**ように配分されている。
 */
export const CYCLE_DRAW: number[] = [7, 5, 6, 7, 5];
/** 5サイクル目以降は1枚 */
export const CYCLE_DRAW_AFTER = 1;

export function drawCountForCycle(cycle: number): number {
  return CYCLE_DRAW[cycle] ?? CYCLE_DRAW_AFTER;
}

export interface DeckList {
  /** カード定義IDの並び。30〜40枚・同名3枚まで */
  cards: string[];
  /** 採用する特殊勝利条件のID（最低3つ） */
  objectives: string[];
}

export interface StartGameOptions {
  P1: DeckList;
  P2: DeckList;
  /** 勝利条件の採用最低数。既定3（創造の神は企画側で調整中なので緩められるようにしておく） */
  objectiveMin?: number;
}

/**
 * デッキ構築の検証。枚数・同名の上限・神の一致を見る。
 * 「大地のカードに海の装備は入らない」を `CardDef.god` で判定している
 * （共通カード = `god:'common'` はどの神でも入る）。
 */
export function validateDeck(engine: Engine, player: PlayerId, cards: string[]): void {
  if (cards.length < DECK_MIN || cards.length > DECK_MAX) {
    throw new RuleError(`${player}: デッキは${DECK_MIN}〜${DECK_MAX}枚（${cards.length}枚）`);
  }
  const god: God = engine.state.players[player].god;
  const byName = new Map<string, number>();
  for (const id of cards) {
    const def = engine.pool.card(id);
    if (def.god !== god && def.god !== 'common') {
      throw new RuleError(`${player}（${god}）のデッキに ${def.name}（${def.god}）は入れられない`);
    }
    const n = (byName.get(def.name) ?? 0) + 1;
    if (n > MAX_COPIES) throw new RuleError(`${def.name} は${MAX_COPIES}枚まで（${n}枚）`);
    byName.set(def.name, n);
  }
}

/**
 * ゲーム開始。デッキを検証してシャッフルし、勝利条件を伏せ、初期手札を配る。
 * マリガンは企画側で「なし」確定なので存在しない。
 *
 * 初期手札は**0サイクル目のドロー**として扱う（企画書のドロー表がそう定義している）ので、
 * `drawPhase` をそのまま呼んでいる。置換効果 `drawDelta` もここから効く。
 */
export async function startGame(engine: Engine, opts: StartGameOptions): Promise<void> {
  const s = engine.state;
  s.cycle = 0;
  s.turn = 0;
  for (const pid of PLAYERS) {
    const list = opts[pid];
    validateDeck(engine, pid, list.cards);
    const pile = s.players[pid].zones.deck[0]!;
    pile.length = 0;
    for (const id of list.cards) pile.push(makeCard(engine, id, pid));
    shufflePile(s, pile);
    setupObjectives(engine, pid, list.objectives, opts.objectiveMin !== undefined ? { min: opts.objectiveMin } : {});
  }
  await drawPhase(engine);
}

/** 降伏は即敗北（企画書「基本ルール」） */
export function surrender(engine: Engine, player: PlayerId): void {
  const s = engine.state;
  if (s.winner) return;
  setWinner(s, opponentOf(player), '降伏');
  logAction(engine, 'win', `${player} が降伏`, player);
}

// ============================================================
// プレイ
// ============================================================

/** 印刷されたキーワードを持つか */
export function hasKeyword(def: CardDef, kw: Keyword): boolean {
  return def.keywords?.includes(kw) === true;
}

/**
 * そのカードに `grantKeyword` でキーワードを与えている継続的効果を探す。
 *
 * 現状データにある唯一の使用例はスカイエンハンスの
 * 「カード1枚を捨てることで、**このカードを**瞬発を持つかのようにプレイしてもよい」で、
 * 手札にある間だけ働く（`active:'inHand'`）自分自身への付与。
 * そこで **手札のカード由来の付与はそのカード自身にだけ効く**と解釈している。
 * 発生源がカードでない付与（別のカードが「あなたの次のプレイに瞬発を与える」等）は
 * 対象を特定する手段が DSL に無いので、黙って全カードに広げず例外にする。
 */
async function grantedKeywordMod(
  engine: Engine,
  player: PlayerId,
  card: CardInstance,
  kw: Keyword,
): Promise<(ActiveMod & { mod: Extract<ContinuousMod, { t: 'grantKeyword' }> }) | undefined> {
  for (const am of await activeMods(engine, 'grantKeyword')) {
    if (am.mod.keyword !== kw) continue;
    const who = await resolvePlayers(am.mod.who, modCtx(engine, am));
    if (!who.includes(player)) continue;
    if (!am.card) {
      throw new NotImplementedError(`カード以外を発生源とする grantKeyword（${am.origin}）`, am.mod);
    }
    if (am.card.uid !== card.uid) continue;
    return am;
  }
  return undefined;
}

function playedThisCycle(s: GameState, player: PlayerId): boolean {
  return s.events.some((e) => e.kind === 'played' && e.player === player && e.cycle === s.cycle);
}

/** `positionRequires`: 新しい項目は現在のトップの上に乗るので、トップが条件を満たすか見る */
async function positionAllows(ctx: Ctx, filter: StackFilter): Promise<boolean> {
  const st = stackOf(ctx.engine.state, undefined);
  const top = st.items[st.items.length - 1];
  if (!top) return false;
  return matchStack(top, filter, ctx);
}

function playLimitKey(player: PlayerId, defId: string): string {
  return `play:${player}:${defId}`;
}

/**
 * 追加コストを払えるか。
 *
 * 効果は実行してみないと結果が分からないものが多いので、**払えないと確実に分かる形だけ**を
 * 弾く（手札が足りない捨て札、いないミニオンの生贄）。判定できない形は「払える」とみなす。
 * ここを緩くしておかないとプレイできる手が不当に減るが、逆に何も見ないと
 * 「手札0枚で『1枚捨てる』を払ったことにして無限に代替プレイできる」穴ができる。
 *
 * `reserved` は手札のうちコストに使えない枚数（プレイしようとしているカード自身）。
 */
async function canPayCost(engine: Engine, player: PlayerId, cost: Effect, reserved = 0): Promise<boolean> {
  const ctx = topCtx(engine, player);
  switch (cost.t) {
    case 'seq':
      for (const e of cost.of) if (!(await canPayCost(engine, player, e, reserved))) return false;
      return true;
    case 'discard': {
      const ps = await resolvePlayers(cost.player, ctx);
      const n = await evalValue(cost.count, ctx);
      for (const p of ps) {
        const avail = (engine.state.players[p].zones.hand[0]?.length ?? 0) - (p === player ? reserved : 0);
        if (avail < n) return false;
      }
      return true;
    }
    case 'sacrificeMinion': {
      const owner = cost.owner ? await resolvePlayers(cost.owner, ctx) : [player];
      const n = await evalValue(cost.count, ctx);
      for (const p of owner) if (totalMinions(engine.state.players[p]) < n) return false;
      return true;
    }
    default:
      return true;
  }
}

/**
 * プレイできない理由を返す（プレイできるなら undefined）。
 * `play()` の検査と、スタックフェイズの「プレイできるカード一覧」で同じ判定を使う。
 * **追加コスト（`play.cost`）を支払えるかは見ない** — コストは効果なので、
 * 実行してみるまで分からないものが混ざる。
 */
export async function playBlockReason(
  engine: Engine,
  player: PlayerId,
  card: CardInstance,
): Promise<string | undefined> {
  const def = engine.pool.card(card.defId);
  const s = engine.state;
  const ctx = topCtx(engine, player);
  const rule = def.play;

  // タイミングの既定はスタックフェイズ（`PlayRule.timing`）。
  // 「瞬発はスタックフェイズにのみ使用できる」（企画書「基本ルール」）もこの既定から出る。
  // 騙し討ちだけが `timing:['orderPhase']` を明示していて、瞬発を持ちながら
  // 順番確定フェイズにプレイできる — カード側の明示がルールの既定に優先する。
  if (s.phase !== 'stack' && s.phase !== 'order') return `${def.name} はこのフェイズにはプレイできない`;
  const now = s.phase === 'order' ? 'orderPhase' : 'stackPhase';
  const timing = rule?.timing ?? ['stackPhase'];
  if (!timing.includes(now)) return `${def.name} はこのフェイズにはプレイできない`;
  if (rule?.mustBeFirstOfCycle && playedThisCycle(s, player)) {
    return `${def.name} はそのサイクルの最初にプレイするカードでなければならない`;
  }
  if (rule?.positionRequires && !(await positionAllows(ctx, rule.positionRequires))) {
    return `${def.name} はこの位置には置けない`;
  }
  if (rule?.cond && !(await evalCondition(rule.cond, ctx))) {
    return `${def.name} のプレイ条件を満たしていない`;
  }
  if (rule?.limit && !limitAvailable(engine, playLimitKey(player, def.id), rule.limit)) {
    return `${def.name} はこれ以上プレイできない`;
  }
  // 追加コスト。プレイするカード自身はコストに使えない
  if (rule?.cost && !(await canPayCost(engine, player, rule.cost, 1))) {
    return `${def.name} の追加コストを払えない`;
  }
  return undefined;
}

/** いまプレイできる手札のカード */
export async function playableCards(engine: Engine, player: PlayerId): Promise<CardInstance[]> {
  const hand = engine.state.players[player].zones.hand[0] ?? [];
  const out: CardInstance[] = [];
  for (const c of hand) {
    if (!(await playBlockReason(engine, player, c))) out.push(c);
  }
  return out;
}

/**
 * その手番でできること。「手札から1枚プレイ」のほかに、
 * `alternativePlay`（クルーエルカーネイジの「手札からカードをプレイする代わりに、
 * カードを1枚捨てることで戦技をスタックに乗せてもよい」）が並ぶ。
 */
export type PlayChoice =
  | { kind: 'card'; card: CardInstance; label: string }
  | { kind: 'alternative'; mod: ActiveMod & { mod: Extract<ContinuousMod, { t: 'alternativePlay' }> }; label: string };

/**
 * `Chooser` に渡ってきた値が `PlayChoice` かどうか。
 * AI は「プレイかパスか」の選択だけを特別扱いするので、その見分けに使う。
 */
export function isPlayChoice(v: unknown): v is PlayChoice {
  if (typeof v !== 'object' || v === null) return false;
  const kind: unknown = Reflect.get(v, 'kind');
  return kind === 'card' || kind === 'alternative';
}

export async function playChoices(engine: Engine, player: PlayerId): Promise<PlayChoice[]> {
  const out: PlayChoice[] = [];
  for (const card of await playableCards(engine, player)) {
    out.push({ kind: 'card', card, label: engine.pool.card(card.defId).name });
  }
  // 代替プレイはスタックフェイズの「1枚プレイする代わり」なので、通常プレイと同じ枠に並ぶ
  if (engine.state.phase === 'stack') {
    for (const am of await activeMods(engine, 'alternativePlay')) {
      const who = await resolvePlayers(am.mod.who, modCtx(engine, am));
      if (!who.includes(player)) continue;
      if (!(await canPayCost(engine, player, am.mod.cost))) continue;
      out.push({ kind: 'alternative', mod: am, label: `${am.origin}（代替プレイ）` });
    }
  }
  return out;
}

/** `alternativePlay` の実行。コストを払って payload をスタックに乗せる */
export async function performAlternativePlay(
  engine: Engine,
  player: PlayerId,
  am: ActiveMod & { mod: Extract<ContinuousMod, { t: 'alternativePlay' }> },
): Promise<void> {
  const ctx = modCtx(engine, am);
  await resolve(am.mod.cost, ctx);
  await pushPayload(ctx, am.mod.play, 'top', undefined, player);
  logAction(engine, 'play', `${player}: ${am.origin} で代替プレイ`, player);
  await drainTriggers(engine);
}

/**
 * 手札のカードをスタックに乗せる。
 * PlayRule（条件 / 追加コスト / 回数 / タイミング / 位置）をここで検査する。
 *
 * **瞬発**（`instant`）はスタックに乗せたあと即座に解決してスタックから降ろす。
 */
export async function play(engine: Engine, player: PlayerId, card: CardInstance): Promise<StackItem> {
  const def = engine.pool.card(card.defId);
  const s = engine.state;
  const ctx = topCtx(engine, player);
  const rule = def.play;

  const blocked = await playBlockReason(engine, player, card);
  if (blocked) throw new RuleError(blocked);

  // 付与された瞬発（スカイエンハンス）を使うか。コストの支払いは手札から取り除いた後
  let granted: Awaited<ReturnType<typeof grantedKeywordMod>>;
  let useGranted = false;
  if (!hasKeyword(def, 'instant')) {
    granted = await grantedKeywordMod(engine, player, card, 'instant');
    if (granted && (!granted.mod.cost || (await canPayCost(engine, player, granted.mod.cost, 1)))) {
      useGranted = await engine.chooser.confirm({
        player,
        prompt: `${def.name} を瞬発としてプレイする？（${granted.origin}）`,
      });
    }
  }

  // 追加コストより先に手札から取り除く。
  // 後にすると「手札を1枚捨てる」コストで自分自身を捨てられてしまい、
  // 墓地とスタックに同じカードが並ぶ
  const hand = s.players[player].zones.hand[0]!;
  const i = hand.findIndex((c) => c.uid === card.uid);
  if (i >= 0) hand.splice(i, 1);

  if (useGranted && granted?.mod.cost) await resolve(granted.mod.cost, modCtx(engine, granted));
  if (rule?.cost) await resolve(rule.cost, ctx);
  if (rule?.limit) consumeLimit(engine, playLimitKey(player, def.id), rule.limit);

  const st = await chooseStack(engine, player);
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

  logAction(engine, 'play', `${player} がプレイ: ${def.name}${s.stacks.length > 1 ? `（${st.id}）` : ''}`, player);
  await emit(itemCtx, { kind: 'played', itemUid: item.uid, player });
  await emit(itemCtx, { kind: 'placedOnStack', itemUid: item.uid, player });

  for (const ab of def.abilities) {
    if (ab.kind === 'onPlay') await resolve(ab.effect, itemCtx);
  }

  await drainTriggers(engine);

  // 瞬発: 解決フェイズを待たずにここで解決してスタックから降ろす。
  // 誘発で打ち消された / 場所を移された場合は解決しない。
  if ((hasKeyword(def, 'instant') || useGranted) && !s.winner && isOnStack(s, item.uid)) {
    await resolveStackItem(itemCtx, item, false);
    await drainTriggers(engine);
  }
  return item;
}

/**
 * カードを乗せるスタックを決める。
 * 「スタックが複数あるとき、互いのプレイヤーはどちらのスタックにカードをプレイしてもよい」
 * （スタック分割）。1つしかなければ選択は起きない。
 */
async function chooseStack(engine: Engine, player: PlayerId): Promise<StackState> {
  const s = engine.state;
  if (s.stacks.length <= 1) return stackOf(s, undefined);
  const [picked] = await engine.chooser.select<StackState>({
    kind: 'stack',
    player,
    prompt: 'カードを乗せるスタックを選ぶ',
    options: s.stacks.map((st) => ({ value: st, label: `${st.id}（${st.items.length}枚）` })),
    min: 1,
    max: 1,
  });
  return picked ?? stackOf(s, undefined);
}

function isOnStack(s: GameState, uid: string): boolean {
  return s.stacks.some((st) => st.items.some((it) => it.uid === uid));
}

// ============================================================
// フェイズ
// ============================================================

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
  logAction(engine, 'phase', `=== サイクル ${s.cycle} 開始（先攻 ${s.first} / 天候 ${s.weather}${s.apocalypse ? '+終末' : ''}）`);
  await revealPhase(engine);
  await drainTriggers(engine);
  if (s.winner) return;
  await emit(topCtx(engine, s.first), { kind: 'cycleStart' });
  await drainTriggers(engine);
}

/**
 * ②ドローフェイズ。サイクル数に応じた枚数を**先攻から**引く。
 * 引き切りペナルティ（不足1枚につき「30点のダメージを受ける」をスタックに追加）は
 * `drawCards` 側に実装されている。
 */
export async function drawPhase(engine: Engine): Promise<void> {
  const s = engine.state;
  s.phase = 'draw';
  const n = drawCountForCycle(s.cycle);
  logAction(engine, 'phase', `② ドローフェイズ（各 ${n} 枚）`);
  for (const pid of turnOrder(s)) {
    if (s.winner) return;
    logAction(engine, 'draw', `${pid} が ${n} 枚引く`, pid);
    await drawCards(topCtx(engine, pid), pid, n);
    await drainTriggers(engine);
  }
}

/**
 * 先攻から交互に「1枚プレイ」か「パス」を選ぶループ。
 * ③スタックフェイズと④順番確定フェイズで共通（プレイできるカードは
 * `playBlockReason` が現在のフェイズで絞る）。
 *
 * - パスを選んだプレイヤーはそのフェイズ中パスしか行えない
 * - プレイできるカードが無ければ強制パス
 * - 両者パスで終了
 */
/** 「プレイするかパスするか」の選択。AI / UI がこの選択を見分けるための目印 */
export const PLAY_PROMPT = 'プレイするカードを選ぶ（選ばなければパス）';

async function playRound(engine: Engine): Promise<void> {
  const s = engine.state;
  const passed: Record<PlayerId, boolean> = { P1: false, P2: false };
  let guard = 0;
  while (!(passed.P1 && passed.P2)) {
    // 同じ手を繰り返せてしまうカード（自分自身を手札に戻す瞬発など）があると
    // ここで止まる。打ち手のバグではなくカード側の無限ループを疑うこと
    if (++guard > 200) throw new RuleError(`${s.phase} フェイズが終わらない（同じ手が繰り返されている疑い）`);
    for (const pid of turnOrder(s)) {
      if (s.winner) return;
      if (passed[pid]) continue;
      const options = await playChoices(engine, pid);
      if (options.length === 0) {
        passed[pid] = true;
        logAction(engine, 'pass', `${pid} はプレイできるカードが無いのでパス（強制）`, pid);
        continue;
      }
      const [chosen] = await engine.chooser.select<PlayChoice>({
        kind: 'card',
        player: pid,
        prompt: PLAY_PROMPT,
        options: options.map((o) => ({ value: o, label: o.label })),
        min: 0,
        max: 1,
      });
      if (!chosen) {
        passed[pid] = true;
        logAction(engine, 'pass', `${pid} がパス`, pid);
        continue;
      }
      if (chosen.kind === 'card') await play(engine, pid, chosen.card);
      else await performAlternativePlay(engine, pid, chosen.mod);
    }
  }
}

/** ③スタックフェイズ */
export async function stackPhase(engine: Engine): Promise<void> {
  engine.state.phase = 'stack';
  logAction(engine, 'phase', '③ スタックフェイズ');
  await playRound(engine);
}

/**
 * ④順番確定フェイズ。
 * 騙し討ちのように `timing:['orderPhase']` を持つカードだけがここでプレイできる。
 */
export async function orderPhase(engine: Engine): Promise<void> {
  const s = engine.state;
  s.phase = 'order';
  logAction(engine, 'phase', '④ 順番確定フェイズ');
  await emit(topCtx(engine, s.first), { kind: 'orderPhaseStart' });
  await drainTriggers(engine);
  if (s.winner) return;
  await playRound(engine);
  // 雷雲のランダム無効化は「順番確定フェイズと解決フェイズの間」（企画書の天候表）
  await applyWeatherNegation(engine);
}

/** ⑤解決フェイズ。上から1つずつ解決する */
export async function resolvePhase(engine: Engine): Promise<void> {
  const s = engine.state;
  s.phase = 'resolve';
  logAction(engine, 'phase', `⑤ 解決フェイズ（${s.stacks.reduce((a, x) => a + x.items.length, 0)}項目）`);
  await emit(topCtx(engine, s.first), { kind: 'resolveStart' });
  await drainTriggers(engine);

  let guard = 0;
  for (;;) {
    if (++guard > 500) throw new RuleError('解決フェイズが終わらない');
    if (s.winner) return;
    // スタックは複数ありうる（スタック分割）。先頭のスタックから順に空にする
    const st = s.stacks.find((x) => x.items.length > 0);
    if (!st) break;
    const top = st.items[st.items.length - 1]!;
    await resolveStackItem(topCtx(engine, top.controller), top, false);
    await drainTriggers(engine);
  }
  // 分割されたスタックは解決フェイズで統合する（次のサイクルは1本から始まる）
  if (s.stacks.length > 1) s.stacks = [s.stacks[0]!];
}

/** ⑥終了フェイズ。期限切れの状態と継続的効果を落とす */
/**
 * 手札上限。既定は10枚（企画書「手札上限 10 ←持ち越し最大数」）。
 * `handLimit` の継続的効果が上書きし、`'none'` なら無制限（叡智保管庫）。
 * 複数あるときは**後から掛かったものが勝つ**（現状データでは重複しない）。
 */
export async function handLimitFor(engine: Engine, player: PlayerId): Promise<number> {
  let limit = HAND_LIMIT;
  for (const am of await activeMods(engine, 'handLimit')) {
    const who = await resolvePlayers(am.mod.who, modCtx(engine, am));
    if (!who.includes(player)) continue;
    limit = am.mod.amount === 'none' ? Number.POSITIVE_INFINITY : await evalValue(am.mod.amount, modCtx(engine, am));
  }
  return limit;
}

/** 終了フェイズ: 手札上限を超えた分を捨てる。捨てるのは本人が選ぶ */
async function discardToHandLimit(engine: Engine): Promise<void> {
  const s = engine.state;
  for (const pid of turnOrder(s)) {
    const limit = await handLimitFor(engine, pid);
    const over = (s.players[pid].zones.hand[0]?.length ?? 0) - limit;
    if (over <= 0) continue;
    logAction(engine, 'phase', `${pid} は手札上限 ${limit} を ${over} 枚超過`, pid);
    // 捨てる処理は discard 効果を通す（discarded イベントと置換効果のため）
    await resolve({ t: 'discard', player: { t: 'self' }, count: over }, topCtx(engine, pid));
    await drainTriggers(engine);
    if (s.winner) return;
  }
}

export async function endTurn(engine: Engine): Promise<void> {
  const s = engine.state;
  s.phase = 'end';
  logAction(engine, 'phase', '⑥ 終了フェイズ');
  await emit(topCtx(engine, s.first), { kind: 'turnEnd' });
  await drainTriggers(engine);
  if (!s.winner) await discardToHandLimit(engine);

  for (const pid of PLAYERS) {
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

// ============================================================
// 1試合を通す
// ============================================================

export interface GameResult {
  winner: PlayerId | 'draw';
  /** 決着したサイクル */
  cycles: number;
}

/**
 * 1試合を最後まで回す。
 *
 * 30枚デッキなら4サイクル目でちょうど引き切り、5サイクル目のドローで
 * 引き切りペナルティが発生するので、**放っておいても決着する**のが設計上の想定。
 * `maxCycles` を超えたら例外にする（黙って引き分けにはしない）。
 */
export async function runGame(engine: Engine, maxCycles = 20): Promise<GameResult> {
  const s = engine.state;
  while (!s.winner) {
    if (s.cycle >= maxCycles) throw new RuleError(`${maxCycles} サイクル経ってもゲームが終わらない`);
    await startCycle(engine);
    if (s.winner) break;
    await drawPhase(engine);
    if (s.winner) break;
    await stackPhase(engine);
    if (s.winner) break;
    await orderPhase(engine);
    if (s.winner) break;
    await resolvePhase(engine);
    if (s.winner) break;
    await endTurn(engine);
    if (s.winner) break;
    await endCycle(engine);
  }
  return { winner: s.winner ?? 'draw', cycles: s.cycle };
}

export { resolveEntities };
export type { GameState, God };
