/**
 * 視点別のビュー。**そのプレイヤーに見せてよいものだけ**を組み立てる。
 *
 * 遠隔対戦ではサーバだけがエンジンを持ち、クライアントにはここで作ったものを送る。
 *
 * ## 削るのではなく、組み立てる
 *
 * `GameState` から不要なフィールドを消す作りにすると、消し忘れが即座に情報漏れになる。
 * `GameState` をそのまま配ると漏れるのは相手の手札だけではない:
 *
 * - `state.rng` … LCGの内部状態。**以後のシャッフルとランダム選択が完全に予測できる**
 * - `limitUses` … キーが `objective:<player>:<id>` 形式なので**伏せた勝利条件のIDが露出する**
 * - `events[].bindings` / `StackItem.snapshots` / 付与された効果の `snapshots`
 *   … 引いたカード・探したカードの実体が入る
 * - `zones.deck` / `zones.foresight` … 山札と予知領域の中身
 *
 * そこでこのモジュールは**ホワイトリスト**でしか値を積まない。
 * 新しいフィールドが `GameState` に増えても、ここに書かない限りクライアントには出ない。
 *
 * ## 自分の伏せた勝利条件は自分には見える
 *
 * 自分で選んだものなので当然見えてよい（CLI の `renderBoard` は件数だけ出していたが、
 * あれは表示の簡略化）。相手のものは**件数だけ**。
 */
import type {
  CounterKind,
  God,
  Keyword,
  PlayerId,
  Species,
  StackItemKind,
  StatusKind,
  TokenKind,
  Weather,
} from '../rules/types';
import { Scope, type Ctx, type Engine, type LogEntry, type LogKind, type LogSnapshot } from './context';
import { objectiveProgress } from './progress';
import { itemName } from './select';
import { opponentOf, type CardInstance, type Phase, type StackItem } from './state';

export interface CardView {
  uid: string;
  defId: string;
  name: string;
  text: string;
  types: string[];
  keywords: Keyword[];
}

export interface StackItemView {
  uid: string;
  controller: PlayerId;
  kind: StackItemKind;
  name: string;
  /**
   * 印刷テキスト。スタックのカードは両者に見えているので隠さない。
   * カードでも NamedAction でもない「生成された効果」には無い。
   */
  text?: string;
  /** カードの種別（攻撃 / ドロー …）。カードのときだけ */
  types?: string[];
  /** 詠唱カウンター（乗っているときだけ） */
  chant?: number;
  immovable?: boolean;
}

export interface ObjectiveView {
  id: string;
  name: string;
  god: God;
  initiative: number | 'special';
  text: string;
  /** 達成度 0〜1。盤面から測れない条件（一撃必殺）は入らない */
  progress?: number;
  /** 「6 >= 10」のような内訳 */
  detail: string;
}

export interface SideView {
  seat: PlayerId;
  god: God;
  name: string;
  life: number;
  handCount: number;
  deckCount: number;
  graveyardCount: number;
  exileCount: number;
  foresightCount: number;
  minions: { species: Species; count: number }[];
  tokens: { name: string; kind: TokenKind; equipped: boolean }[];
  status: Record<StatusKind, number>;
  counters: Record<CounterKind, number>;
  /** 公開済みの勝利条件（両者に見える） */
  revealed: ObjectiveView[];
  /** 伏せてある枚数（両者に見える） */
  hiddenCount: number;
  /** ここから下は**自分の側にしか入らない** */
  hand?: CardView[];
  foresight?: CardView[];
  hidden?: ObjectiveView[];
}

export interface LogView {
  text: string;
  depth: number;
  kind?: LogKind;
  cycle?: number;
  phase?: Phase;
  player?: PlayerId;
  snap?: LogSnapshot;
}

export interface PlayerView {
  /** このビューを見る席 */
  you: PlayerId;
  cycle: number;
  turn: number;
  phase: Phase;
  weather: Weather;
  apocalypse: boolean;
  /** このサイクルの先攻 */
  first: PlayerId;
  me: SideView;
  opp: SideView;
  stacks: { id: string; items: StackItemView[] }[];
  /** 行動ログ。`from` から後ろだけを入れる（演出のタイムラインにも使う） */
  log: LogView[];
  /** ログ全体の行数。次に「どこから」を指定するのに使う */
  logLength: number;
  result?: { winner: PlayerId | 'draw'; reason?: string; cycles: number };
}

export interface ViewOptions {
  /** プレイヤーの表示名 */
  names?: Record<PlayerId, string>;
  /** ログをこの行から入れる（既定は全部） */
  logFrom?: number;
}

/** `itemName` などの表示ヘルパ用。中で見るのは `engine.pool` だけ */
function viewCtx(engine: Engine, it: StackItem): Ctx {
  return { engine, self: it.controller, item: it, stackId: it.stackId, vars: new Scope() };
}

function cardView(engine: Engine, c: CardInstance): CardView {
  const def = engine.pool.card(c.defId);
  return {
    uid: c.uid,
    defId: c.defId,
    name: def.name,
    text: def.text,
    types: def.types,
    keywords: def.keywords ?? [],
  };
}

function logView(e: LogEntry): LogView {
  return {
    text: e.text,
    depth: e.depth,
    ...(e.kind !== undefined ? { kind: e.kind } : {}),
    ...(e.cycle !== undefined ? { cycle: e.cycle } : {}),
    ...(e.phase !== undefined ? { phase: e.phase } : {}),
    ...(e.player !== undefined ? { player: e.player } : {}),
    ...(e.snap !== undefined ? { snap: e.snap } : {}),
  };
}

async function sideView(
  engine: Engine,
  seat: PlayerId,
  own: boolean,
  name: string,
): Promise<SideView> {
  const p = engine.state.players[seat];
  const progress = await objectiveProgress(engine, seat);
  const toObjective = (x: (typeof progress)[number]): ObjectiveView => ({
    id: x.objective.id,
    name: x.objective.name,
    god: x.objective.god,
    initiative: x.objective.initiative,
    text: x.objective.text,
    ...(x.progress !== undefined ? { progress: x.progress } : {}),
    detail: x.detail,
  });

  const side: SideView = {
    seat,
    god: p.god,
    name,
    life: p.life,
    handCount: p.zones.hand[0]?.length ?? 0,
    deckCount: p.zones.deck.reduce((a, d) => a + d.length, 0),
    graveyardCount: p.zones.graveyard[0]?.length ?? 0,
    exileCount: p.zones.exile[0]?.length ?? 0,
    foresightCount: p.zones.foresight[0]?.length ?? 0,
    minions: Object.entries(p.minions)
      .filter(([, n]) => n > 0)
      .map(([species, count]) => ({ species, count })),
    tokens: p.tokens.map((t) => {
      const def = engine.pool.token(t.defId);
      return { name: def.name, kind: def.kind, equipped: t.equipped };
    }),
    status: { ...p.status },
    counters: { ...p.counters },
    revealed: progress.filter((x) => x.revealed).map(toObjective),
    hiddenCount: p.objectives.length,
  };

  if (own) {
    // 自分の側にだけ入れるもの。相手のビューには**この分岐を通らない**ので出ない
    side.hand = (p.zones.hand[0] ?? []).map((c) => cardView(engine, c));
    side.foresight = (p.zones.foresight[0] ?? []).map((c) => cardView(engine, c));
    side.hidden = progress.filter((x) => !x.revealed).map(toObjective);
  }
  return side;
}

/**
 * `viewer` に見せてよい盤面を組み立てる。
 * **相手の手札・山札・予知領域・伏せた勝利条件、`rng`、`limitUses`、`events` は入らない。**
 */
export async function playerView(
  engine: Engine,
  viewer: PlayerId,
  opts: ViewOptions = {},
): Promise<PlayerView> {
  const s = engine.state;
  const foe = opponentOf(viewer);
  const nameOf = (p: PlayerId): string => opts.names?.[p] ?? s.players[p].god;
  const from = opts.logFrom ?? 0;

  const view: PlayerView = {
    you: viewer,
    cycle: s.cycle,
    turn: s.turn,
    phase: s.phase,
    weather: s.weather,
    apocalypse: s.apocalypse,
    first: s.first,
    me: await sideView(engine, viewer, true, nameOf(viewer)),
    opp: await sideView(engine, foe, false, nameOf(foe)),
    stacks: s.stacks.map((st) => ({
      id: st.id,
      items: st.items.map((it) => {
        const ctx = viewCtx(engine, it);
        const item: StackItemView = {
          uid: it.uid,
          controller: it.controller,
          kind: it.kind,
          name: itemName(ctx, it),
        };
        // 手札のカードと同じように、カーソルを合わせたら効果が読めるようにする
        const def = it.kind === 'card' && it.card ? engine.pool.card(it.card.defId) : undefined;
        if (def) {
          item.text = def.text;
          item.types = def.types;
        } else if (it.kind === 'action' && it.actionId) {
          item.text = engine.pool.action(it.actionId).text;
        }
        if (it.counters.chant) item.chant = it.counters.chant;
        if (it.immovable) item.immovable = true;
        return item;
      }),
    })),
    log: s.winner !== undefined || from < engine.log.length ? engine.log.slice(from).map(logView) : [],
    logLength: engine.log.length,
  };

  if (s.winner !== undefined) {
    view.result = {
      winner: s.winner,
      cycles: s.cycle,
      ...(s.winReason !== undefined ? { reason: s.winReason } : {}),
    };
  }
  return view;
}
