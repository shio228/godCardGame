/**
 * ゲーム状態の表現。
 *
 * 方針（確定）: **ミュータブル + スナップショット**。
 * エンジン内部では state を直接書き換え、巻き戻し・ゴールデンテストのための
 * 複製は `snapshot()` / `restore()` で行う。
 */
import type {
  CounterKind,
  DamageTag,
  Duration,
  EventKind,
  God,
  MinionPool,
  PlayerId,
  Species,
  StackItemKind,
  StatusKind,
  Weather,
  Zone,
  ContinuousMod,
  Effect,
  Condition,
  GrantedTrigger,
} from '../rules/types';

// ============================================================
// 実体（インスタンス）
// ============================================================

export interface CardInstance {
  uid: string;
  defId: string;
  owner: PlayerId;
}

/** ゾーンの中身。デッキは分割されうる（並列思考）ので山を配列で持つ */
export type Pile = CardInstance[];

export interface TokenInstance {
  uid: string;
  defId: string;
  owner: PlayerId;
  /** 装備しているか（生成しただけで未装備の状態がある） */
  equipped: boolean;
  /** createToken の mark。TokenFilter.mark で「このカードが生成したもの」を絞る */
  mark?: string;
}

/** ダメージ・効果の着弾先の実体。ミニオンは個体を持たず「種族 + 所有者」で表す */
export type Entity =
  | { kind: 'player'; player: PlayerId }
  | { kind: 'minion'; species: Species; owner: PlayerId };

export function playerEntity(p: PlayerId): Entity {
  return { kind: 'player', player: p };
}

export function entityOwner(e: Entity): PlayerId {
  return e.kind === 'player' ? e.player : e.owner;
}

export function sameEntity(a: Entity, b: Entity): boolean {
  if (a.kind === 'player' && b.kind === 'player') return a.player === b.player;
  if (a.kind === 'minion' && b.kind === 'minion') return a.species === b.species && a.owner === b.owner;
  return false;
}

// ============================================================
// 束縛値（let / bind / snapshot / 暗黙束縛の中身）
// ============================================================

export type Bound =
  | { of: 'number'; value: number }
  | { of: 'player'; value: PlayerId }
  | { of: 'species'; value: Species }
  | { of: 'entity'; value: Entity }
  | { of: 'stack'; value: StackItem[] }
  | { of: 'card'; value: CardInstance[] }
  | { of: 'token'; value: TokenInstance[] };

// ============================================================
// スタック
// ============================================================

/**
 * スタック上の1項目。card / effect / action を統一表現する（設計書 §2）。
 * items[0] がボトム、末尾がトップ。解決はトップから。
 */
export interface StackItem {
  uid: string;
  kind: StackItemKind;
  controller: PlayerId;
  stackId: string;
  /** kind==='card' */
  card?: CardInstance;
  /** kind==='effect' — 生成された効果 */
  effect?: Effect;
  text?: string;
  /** kind==='action' — NamedActionDef.id */
  actionId?: string;
  counters: Record<CounterKind, number>;
  /** その項目が存在する間ずっと残る束縛（ability をまたぐ） */
  snapshots: Record<string, Bound>;
  /** スタック上で位置を変えられない */
  immovable: boolean;
  /** redirect 効果で着弾先が差し替えられた場合 */
  redirectTo?: Entity;
}

export interface StackState {
  id: string;
  items: StackItem[];
}

// ============================================================
// 状態付与（回避・シールド・軽減・装甲）
// ============================================================

export interface StatusGrant {
  kind: StatusKind;
  amount: number;
  duration: Duration;
  /** whileOnStack の場合の発生源 */
  sourceUid?: string;
  /** capFromThisSource の判定用 */
  sourceKey?: string;
}

// ============================================================
// 継続的効果 / 付与された誘発
// ============================================================

export interface ContinuousInstance {
  id: string;
  mod: ContinuousMod;
  duration: Duration;
  /** 「あなた」が誰を指すか（＝この効果のコントローラー） */
  controller: PlayerId;
  /** 発生源のスタック項目。whileOnStack の生存判定と sourceFilter に使う */
  sourceUid?: string;
  cond?: Condition;
  onceOnly?: boolean;
  used?: boolean;
}

export interface GrantedTriggerInstance {
  id: string;
  trigger: GrantedTrigger;
  duration: Duration;
  controller: PlayerId;
  sourceUid?: string;
  onceOnly?: boolean;
  used?: boolean;
}

// ============================================================
// イベントログ
// ============================================================

/**
 * 発生したイベントの記録。`countEvent` はこのログを数える。
 * bindings に暗黙束縛（count / amount / source …）を載せて誘発側へ渡す。
 */
export interface GameEvent {
  seq: number;
  kind: EventKind;
  cycle: number;
  turn: number;
  weather: Weather;
  /**
   * ダメージイベントで「与えた側」。damageTaken から加害者を引くために持つ。
   * `countEvent.by` が見るのはこちらではなく `player`（イベントの主体）。
   */
  dealer?: PlayerId;
  /** 発生源のスタック項目 uid（countEvent.source） */
  sourceUid?: string;
  /** イベントの主語になるスタック項目（played / resolved / bounced …） */
  itemUid?: string;
  /**
   * そのイベントの主体となるプレイヤー。`countEvent.by` はこれと照合する。
   *   damageDealt → 与えた側 / damageTaken → 受けた側
   *   drawn・discarded → 引いた/捨てた本人 / minionDied → ミニオンの持ち主
   */
  player?: PlayerId;
  entity?: Entity;
  /** objectiveRevealed で公開された勝利条件の id */
  objectiveId?: string;
  tags?: DamageTag[];
  species?: Species;
  /**
   * そのイベントが表す「数量」。ダメージなら点数、ミニオンなら体数、ドローなら枚数。
   * `countEvent` の measure:'units' で合計される値であり、
   * 誘発の granularity:'perUnit' の反復数でもある。省略時は 1 として扱う。
   */
  units?: number;
  amount?: number;
  bindings?: Record<string, Bound>;
}

// ============================================================
// プレイヤー / ゲーム
// ============================================================

export type Phase = 'cycleStart' | 'draw' | 'stack' | 'order' | 'resolve' | 'end';

export interface PlayerState {
  id: PlayerId;
  god: God;
  life: number;
  /** ゾーン → 山の配列。deck 以外は基本 [0] のみを使う */
  zones: Record<Zone, Pile[]>;
  status: Record<StatusKind, number>;
  statusGrants: StatusGrant[];
  /** 獄焔などプレイヤーに乗るカウンタ */
  counters: Record<CounterKind, number>;
  minions: MinionPool;
  tokens: TokenInstance[];
  /** 公開済み勝利条件の id */
  revealedObjectives: string[];
  /** 未公開の勝利条件の id */
  objectives: string[];
}

export interface GameState {
  cycle: number;
  turn: number;
  phase: Phase;
  /** このサイクルの先攻プレイヤー */
  first: PlayerId;
  weather: Weather;
  /** 終末（表裏の枠外） */
  apocalypse: boolean;
  players: Record<PlayerId, PlayerState>;
  stacks: StackState[];
  continuous: ContinuousInstance[];
  grantedTriggers: GrantedTriggerInstance[];
  events: GameEvent[];
  /** Limit の消費数。キーは `${scopeEpoch}|${limitKey}` */
  limitUses: Record<string, number>;
  /** uid 採番 */
  seq: number;
  /** LCG の内部状態 */
  rng: number;
  winner?: PlayerId | 'draw';
}

// ============================================================
// 天候
// ============================================================

const FRONT: Weather[] = ['calm', 'clear', 'rain', 'blizzard'];

/** 凪は表扱い・裏なし。終末は GameState.apocalypse の別枠 */
export function weatherSide(w: Weather): 'front' | 'back' {
  return FRONT.includes(w) ? 'front' : 'back';
}

/** 表 ⇄ 裏の対応 */
const FLIP: Partial<Record<Weather, Weather>> = {
  clear: 'blaze',
  blaze: 'clear',
  rain: 'downpour',
  downpour: 'rain',
  blizzard: 'thundercloud',
  thundercloud: 'blizzard',
};

export function flipWeather(w: Weather): Weather {
  return FLIP[w] ?? w;
}

export const ALL_WEATHERS: Weather[] = [
  'calm',
  'clear',
  'blaze',
  'rain',
  'downpour',
  'blizzard',
  'thundercloud',
];

// ============================================================
// 生成 / 複製
// ============================================================

const ZONES: Zone[] = ['deck', 'hand', 'graveyard', 'foresight', 'exile', 'field', 'staging'];

function emptyZones(): Record<Zone, Pile[]> {
  const z = {} as Record<Zone, Pile[]>;
  for (const k of ZONES) z[k] = [[]];
  return z;
}

export function createPlayer(id: PlayerId, god: God, life = 30): PlayerState {
  return {
    id,
    god,
    life,
    zones: emptyZones(),
    status: { evasion: 0, shield: 0, reduction: 0, armor: 0 },
    statusGrants: [],
    counters: {},
    minions: {},
    tokens: [],
    revealedObjectives: [],
    objectives: [],
  };
}

export interface CreateStateOptions {
  p1God: God;
  p2God: God;
  first?: PlayerId;
  life?: number;
  weather?: Weather;
  cycle?: number;
  seed?: number;
}

export function createState(opts: CreateStateOptions): GameState {
  return {
    cycle: opts.cycle ?? 0,
    turn: 0,
    phase: 'stack',
    first: opts.first ?? 'P1',
    weather: opts.weather ?? 'calm',
    apocalypse: false,
    players: {
      P1: createPlayer('P1', opts.p1God, opts.life ?? 30),
      P2: createPlayer('P2', opts.p2God, opts.life ?? 30),
    },
    stacks: [{ id: 'S0', items: [] }],
    continuous: [],
    grantedTriggers: [],
    events: [],
    limitUses: {},
    seq: 1,
    rng: opts.seed ?? 12345,
  };
}

export function snapshot(state: GameState): GameState {
  return structuredClone(state);
}

export function restore(target: GameState, snap: GameState): void {
  Object.assign(target, structuredClone(snap));
}

// ============================================================
// 小道具
// ============================================================

export function nextUid(state: GameState, prefix: string): string {
  return `${prefix}${state.seq++}`;
}

/** 決定的な LCG（ランダム要素の再現性のため） */
export function rngInt(state: GameState, max: number): number {
  state.rng = (state.rng * 1664525 + 1013904223) >>> 0;
  return max <= 0 ? 0 : state.rng % max;
}

export function shufflePile(state: GameState, pile: Pile): void {
  for (let i = pile.length - 1; i > 0; i--) {
    const j = rngInt(state, i + 1);
    const a = pile[i]!;
    const b = pile[j]!;
    pile[i] = b;
    pile[j] = a;
  }
}

export function opponentOf(p: PlayerId): PlayerId {
  return p === 'P1' ? 'P2' : 'P1';
}

/** 先攻 → 後攻の順に並べる（誘発順の既定） */
export function turnOrder(state: GameState): PlayerId[] {
  return [state.first, opponentOf(state.first)];
}

export function findStackItem(state: GameState, uid: string): StackItem | undefined {
  for (const s of state.stacks) {
    const it = s.items.find((i) => i.uid === uid);
    if (it) return it;
  }
  return undefined;
}

export function stackOf(state: GameState, id: string | undefined): StackState {
  if (id) {
    const s = state.stacks.find((x) => x.id === id);
    if (s) return s;
  }
  return state.stacks[0]!;
}

export function minionCount(p: PlayerState, species: Species): number {
  return p.minions[species] ?? 0;
}

export function totalMinions(p: PlayerState): number {
  return Object.values(p.minions).reduce((a, b) => a + b, 0);
}
