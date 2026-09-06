/**
 * ルールエンジン — カード効果のデータ表現（DSL）  v2
 *
 * v1 からの主な変更（各神の設定シートを読んで判明した不足）:
 *   - NamedAction（戦技 / 攻撃指令 / 防御指令 / レゾナンス）を第一級の概念に昇格
 *   - ダメージ対象を EntitySel（プレイヤー / ミニオン）に拡張
 *   - ダメージにタグ（斬撃・刺突・打撃・自傷・天候…）を持たせ、タグで修正・無効化できるように
 *   - トークン（武器・防具・神器）とミニオン（種族ごとの数）を追加
 *   - プレイ制約（条件 / 追加コスト / 回数 / タイミング / 位置）を CardDef に追加
 *   - 置換効果（ライフ0の肩代わり、ダメージ無効、天候変更の打ち消し、代替プレイ）を追加
 *   - デッキとスタックが複数存在しうる前提に変更
 *
 * 設計方針: ハイブリッド。定型効果は宣言的データ、ゲームの基礎構造を書き換えるものだけ
 * { t: 'handler', id } でコードに逃がす。
 */

// ============================================================
// 0. 基本語彙
// ============================================================

export type PlayerId = 'P1' | 'P2';

export type God = 'earth' | 'sea' | 'sky' | 'life' | 'creation' | 'common';

/** 天候。終末は表裏の枠外なので GameState 側の別フラグで持つ */
export type Weather =
  | 'calm'          // 凪（表扱い・裏なし）
  | 'clear'         // 晴
  | 'blaze'         // 炎天
  | 'rain'          // 雨
  | 'downpour'      // 豪雨
  | 'blizzard'      // 吹雪
  | 'thundercloud'; // 雷雲

export type Zone =
  | 'deck'
  | 'hand'
  | 'graveyard'   // 墓地・使用済み領域
  | 'foresight'   // 予知領域
  | 'exile'       // 除外
  | 'field'       // 装備・ミニオン・永続効果の置き場
  /**
   * 一時領域。効果の解決中だけ存在し、解決の終わりに空でなければならない。
   * 「デッキからカードを3枚探し、1枚を手札に・1枚を墓地に・1枚をデッキの下に」のように
   * 選んだ集合を一旦置いてから振り分ける効果で使う。
   */
  | 'staging';

export type Keyword =
  | 'instant'   // 瞬発
  | 'static'    // 常在（表記上の総称。実装は continuous / triggered / activated に分解）
  | 'chant';    // 詠唱

/**
 * カウンタ種別。文字列で開いておく（獄焔・絶凍のような神ごとの状態異常が増えるため）。
 * 'chant' = 詠唱カウンター（スタック項目に乗る）
 * 'infernalFlame' = 獄焔（プレイヤーに乗り、決して減少しない）
 */
export type CounterKind = string;

/** ライフ以外の防御リソース */
export type StatusKind =
  | 'evasion'    // 回避: この値以下のダメージを無効化。ターン終了時消失
  | 'shield'     // シールド: ダメージ時に優先消費。ターン終了時0
  | 'reduction'  // 軽減: ダメージから減算
  | 'armor';     // 装甲: 減算だが ignoreArmor で貫通される

export type Duration = 'thisTurn' | 'thisCycle' | 'thisGame' | 'whileOnStack';

/**
 * ダメージタグ。修正・無効化・カウントの対象を絞るために使う。
 * 例: 「あなたの与える斬撃のダメージは＋1」「自傷ダメージは軽減できない」
 *     「炎天によるダメージを受けなくなる」「攻撃指令によりダメージを与えたなら」
 */
export type DamageTag =
  | 'slash' | 'thrust' | 'strike'   // 斬撃 / 刺突 / 打撃
  | 'melee' | 'combatArt'           // 近接 / 戦技由来
  | 'attackOrder'                   // 攻撃指令由来
  | 'fire' | 'weather' | 'self'     // 炎 / 天候 / 自傷
  | 'system';                       // 引き切りペナルティなど

// ============================================================
// 1. 参照（Selector）
// ============================================================

export type PlayerSel =
  | { t: 'self' }
  | { t: 'opponent' }
  | { t: 'each' }
  | { t: 'target' }
  | { t: 'controllerOf'; of: StackSel }
  | { t: 'var'; name: string };

/** ミニオンの種族。'human' | 'angel' | 'wraith' | 'beast' を想定するが開いておく */
export type Species = string;

/** 種族の絞り込み。「死霊以外のミニオン」のような否定が頻出する */
export interface SpeciesFilter {
  is?: SpeciesRef | SpeciesRef[];
  not?: SpeciesRef | SpeciesRef[];
}

export type SpeciesRef =
  | Species
  | { t: 'choose'; chooser?: PlayerSel; exclude?: SpeciesRef; onlyExisting?: boolean }
  | { t: 'any' }
  | { t: 'var'; name: string };

/** ダメージ・効果の着弾先。プレイヤーとミニオンの両方を取りうる */
export type EntitySel =
  | { t: 'player'; who: PlayerSel }
  | { t: 'target' }                                        // 「対象に」
  /** 「相手かミニオンを選び」 */
  | { t: 'chooseEntity'; among: ('self' | 'opponent' | 'minion')[]; chooser?: PlayerSel; species?: SpeciesRef }
  | { t: 'minion'; species: SpeciesRef; owner: PlayerSel }
  | { t: 'var'; name: string };

/**
 * スタック上の項目（カード・生成された効果・NamedAction）を指す。
 * スタックは複数存在しうる（創造「スタック分割」）ため、既定は「この項目のあるスタック」。
 */
export type StackSel =
  | { t: 'this' }
  | { t: 'top'; offset?: number }
  | { t: 'bottom'; offset?: number }
  | { t: 'above'; of: StackSel; n?: number }
  | { t: 'below'; of: StackSel; n?: number }
  | { t: 'choose'; count: Value; upTo?: boolean; chooser?: PlayerSel; filter?: StackFilter }
  | { t: 'random'; count: Value; filter?: StackFilter }
  | { t: 'all'; filter?: StackFilter }
  | { t: 'var'; name: string };

export interface StackFilter {
  /** 否定。ここに書いた条件に合致するものを除外する（「『〜』と名の付くカード以外」） */
  not?: StackFilter;
  /** 位置で絞る: このセレクタが指す項目と同一のものだけ通す */
  is?: StackSel;
  controller?: PlayerSel;
  god?: God | God[];
  hasType?: string | string[];
  name?: string;
  nameContains?: string;
  sameNameAs?: StackSel;
  hasKeyword?: Keyword;
  kind?: StackItemKind | StackItemKind[];
  hasCounter?: CounterKind;
  /** NamedAction を id で絞る（「攻撃指令が対象に取られなくなり」） */
  actionId?: string;
  /** ダメージを与える項目か */
  dealsDamage?: boolean;
  /** 複数スタックがあるときの探索範囲。既定は thisStack */
  scope?: 'thisStack' | 'allStacks';
}

export type StackItemKind = 'card' | 'effect' | 'action';

export interface ZoneRef {
  zone: Zone;
  owner: PlayerSel;
  /** デッキが分割されている場合の識別（並列思考）。未指定なら全体 or 単一 */
  pile?: Value | { t: 'choose'; chooser?: PlayerSel } | { t: 'any' };
}

export type CardSel =
  | { t: 'top'; from: ZoneRef; count: Value }
  | { t: 'bottom'; from: ZoneRef; count: Value }
  | { t: 'choose'; from: ZoneRef; count: Value; upTo?: boolean; chooser?: PlayerSel; filter?: CardFilter }
  | { t: 'random'; from: ZoneRef; count: Value; filter?: CardFilter }
  | { t: 'all'; from: ZoneRef; filter?: CardFilter }
  | { t: 'var'; name: string };

export interface CardFilter {
  /** 否定。ここに書いた条件に合致するものを除外する */
  not?: CardFilter;
  /** 同一性で絞る: このセレクタ（多くは snapshot した集合）が指すカードだけ通す */
  is?: CardSel;
  god?: God | God[];
  hasType?: string | string[];
  name?: string;
  /** 「『創命』が名前に含まれるカード」 */
  nameContains?: string;
  hasKeyword?: Keyword;
}

/** 場に出ている装備トークン（武器・防具・神器） */
export type TokenSel =
  | { t: 'choose'; count: Value; upTo?: boolean; chooser?: PlayerSel; filter?: TokenFilter }
  | { t: 'all'; filter?: TokenFilter }
  | { t: 'var'; name: string };

export interface TokenFilter {
  /** 否定。ここに書いた条件に合致するものを除外する */
  not?: TokenFilter;
  kind?: TokenKind | TokenKind[];
  name?: string;
  owner?: PlayerSel;
  /** 「まだ装備しておらず神器でない」 */
  notEquipped?: boolean;
  /**
   * 出自マーカー。createToken の mark と対応する。
   * 「そのサイクル終了時、**このカードによって生成した**武器もしくは防具1つを墓地に置く」用。
   */
  mark?: string;
}

export type TokenKind = 'weapon' | 'armor' | 'relic';

// ============================================================
// 2. 数値式（Value）
// ============================================================

export type Value =
  | number
  | { t: 'cycle' }
  | { t: 'var'; name: string }
  | { t: 'counters'; kind: CounterKind; on: StackSel }            // 詠唱カウンター
  | { t: 'playerCounter'; kind: CounterKind; of: PlayerSel }      // 獄焔など
  | { t: 'life'; of: PlayerSel }
  | { t: 'status'; kind: StatusKind; of: PlayerSel }
  | { t: 'countStack'; filter?: StackFilter }
  | { t: 'countZone'; of: ZoneRef; filter?: CardFilter }
  | { t: 'countTokens'; filter?: TokenFilter }                    // 武器の装備数
  | { t: 'countMinions'; species?: SpeciesRef | SpeciesFilter; of: PlayerSel }
  /**
   * 種族の「数」ではなく「種類数」を数える。
   * 「このサイクル死亡した死霊以外のミニオン1種類につき1枚」用。
   */
  | { t: 'countSpeciesKinds'; event?: EventKind; scope?: 'turn' | 'cycle' | 'game'; of?: PlayerSel; species?: SpeciesFilter }
  /** 「このカードに連続しているあなたのカードか効果の数」 */
  | { t: 'consecutiveRun'; from: StackSel; controller?: PlayerSel; includeSelf?: boolean }
  /**
   * イベントを数える。source を指定すると「**このカードが**与えたダメージ」のように
   * 発生源のスタック項目単位で数えられる。
   */
  | {
      t: 'countEvent';
      event: EventKind;
      scope: 'turn' | 'cycle' | 'game';
      /**
       * 何を数えるか。**必須**。
       *   'events' … イベントの発生「回数」。1イベント = 1。
       *               「天候が5回変わったなら」「ダメージを与えた**なら**」
       *   'units'  … イベントが表す「数量」の合計。
       *               ダメージなら点数、ミニオンなら体数、ドローなら枚数。
       *               「死亡した死霊以外のミニオンに等しい数」「ダメージを受けていないなら」
       *
       * この2つは「効果が起きたが数量が0だった」場面で結果が割れる
       * （軽減しきったダメージ / ミニオン0体での攻撃指令）。
       * 既定値を置くとどちらの読みか分からなくなるので、必ず書かせる。
       *
       * damageDealt の units は「与えたダメージ」（サイクルボーナス・修正込み、軽減前）、
       * damageTaken の units は「実際に通ったダメージ」。設計書 §5 の用語に合わせている。
       */
      measure: 'events' | 'units';
      by?: PlayerSel;
      /**
       * **誰に当たったか**で絞る（ダメージのイベントだけ）。
       * 「あなたが10回目のダメージを与えたなら」のような**攻撃回数**の条件は、
       * これを `opponent` にしないと**自傷まで数えてしまう**
       * （ブレイジングラッシュの「カードをプレイするたび2点受ける」など）。
       */
      to?: PlayerSel;
      source?: StackSel;
      tags?: DamageTag[];
      weather?: Weather | Weather[];
      /** 「選んだ種類のミニオンがこのサイクル死亡した数」 */
      species?: SpeciesFilter;
    }
  | { t: 'snapshotValue'; name: string }                          // 記録した値（海の抱擁）
  /** let / bind で束縛した集合の要素数 */
  | { t: 'countOf'; name: string }
  | { t: 'chooseNumber'; chooser: PlayerSel; min?: Value; max?: Value }
  | { t: 'add'; a: Value; b: Value }
  | { t: 'sub'; a: Value; b: Value }
  | { t: 'mul'; a: Value; b: Value }
  | { t: 'min'; a: Value; b: Value }
  | { t: 'max'; a: Value; b: Value };

// ============================================================
// 3. 条件（Condition）
// ============================================================

export type Condition =
  | { t: 'cmp'; a: Value; op: '==' | '!=' | '>' | '>=' | '<' | '<='; b: Value }
  | { t: 'weatherIs'; weather: Weather | Weather[] }
  | { t: 'weatherSide'; side: 'front' | 'back' }   // 「いずれかの表／裏であるなら」
  | { t: 'apocalypse' }
  | { t: 'and'; of: Condition[] }
  | { t: 'or'; of: Condition[] }
  | { t: 'not'; of: Condition }
  | { t: 'exists'; stack: StackSel }
  /** 束縛したスタック項目 / カードが条件を満たすか（「瞬発を持つカードを選ぶなら」） */
  | { t: 'matchesStack'; item: StackSel; filter: StackFilter }
  | { t: 'matchesCard'; card: CardSel; filter: CardFilter }
  | { t: 'handler'; id: string };

// ============================================================
// 4. NamedAction — 戦技 / 攻撃指令 / 防御指令 / レゾナンス
//    4神に横断して現れる「神ごとの定型アクション」。
//    カードから何度も参照され、スタックにも乗るので第一級の定義とする。
// ============================================================

export interface NamedActionDef {
  id: string;                 // 'earth/slash' など
  name: string;               // 斬撃 / 攻撃指令 / レゾナンス
  god: God;
  text: string;
  /** このアクションが属するグループ（「戦技を1回行う」の選択肢集合） */
  group?: string;             // 'earth/combatArt'
  effect: Effect;
  /** このアクションが与えるダメージに付くタグ */
  tags?: DamageTag[];
}

export type ActionRef =
  | string                                                          // アクションID直指定
  | { t: 'chooseFrom'; group: string; chooser?: PlayerSel; distinct?: boolean }
  | { t: 'var'; name: string };

// ============================================================
// 5. 効果（Effect）
// ============================================================

export type StackPayload =
  | { t: 'effect'; text: string; effect: Effect }
  | { t: 'action'; action: ActionRef }
  | { t: 'cardRef'; card: CardSel };

export interface DamageFlags {
  /** 「装甲によって軽減されない」 */
  ignoreArmor?: boolean;
  /** サイクルダメージボーナスを受けない */
  ignoreCycleBonus?: boolean;
  /** 「軽減されず」 */
  unreducible?: boolean;
  /** 「回避されない」 */
  unavoidable?: boolean;
}

export type Effect =
  // ---- 原子効果 ----
  /**
   * species を指定すると「どの種族が与えたダメージか」が DamageEvent に載る。
   * 「攻撃指令により**人で**ダメージを与えたとき」のような誘発条件に使う。
   */
  | { t: 'damage'; to: EntitySel; amount: Value; times?: Value; tags?: DamageTag[]; species?: SpeciesRef; flags?: DamageFlags }
  | { t: 'heal'; to: PlayerSel; amount: Value }
  | { t: 'loseLife'; to: PlayerSel; amount: Value }
  | { t: 'setLife'; to: PlayerSel; amount: Value }
  | { t: 'draw'; player: PlayerSel; count: Value; from?: ZoneRef }
  | { t: 'discard'; player: PlayerSel; count: Value; chooser?: PlayerSel; filter?: CardFilter }
  | { t: 'foresee'; player: PlayerSel; count: Value }
  | { t: 'reveal'; cards: CardSel }
  | { t: 'moveCards'; cards: CardSel; to: ZoneRef; position?: 'top' | 'bottom'; order?: 'choose' | 'keep' | 'random'; reveal?: boolean }
  | { t: 'reorderCards'; cards: CardSel; by?: PlayerSel }
  | { t: 'shuffle'; of: ZoneRef }
  | { t: 'splitDeck'; of: ZoneRef; parts: Value }                 // 並列思考
  // ---- スタック操作 ----
  | { t: 'reorderStack'; items: StackSel; mode: 'choose' | 'random' | 'swap'; by?: PlayerSel }
  | { t: 'counterStack'; target: StackSel }
  | { t: 'moveStackItem'; item: StackSel; to: 'top' | 'bottom' | 'above' | 'below' | 'anywhere' | 'replace'; relativeTo?: StackSel; by?: PlayerSel }
  | { t: 'moveStackToZone'; item: StackSel; to: ZoneRef }          // バウンス・墓地送り・除外
  | { t: 'addToStack'; payload: StackPayload; times?: Value; position?: 'top' | 'above' | 'below'; relativeTo?: StackSel; immediate?: boolean }
  /** スタックを（サイクルを終わらせずに）解決する。keepOnStack で「解決するが取り除かない」 */
  | { t: 'resolveStack'; items: StackSel; keepOnStack?: boolean }
  | { t: 'redirect'; item: StackSel; to: EntitySel }
  | { t: 'addCounter'; kind: CounterKind; on: StackSel; amount: Value }
  | { t: 'removeCounter'; kind: CounterKind; on: StackSel; amount: Value }
  // ---- NamedAction ----
  | { t: 'performAction'; action: ActionRef; times?: Value; distinct?: boolean }
  // ---- トークン / ミニオン ----
  /** mark を付けると、後から TokenFilter.mark で「このカードが生成したもの」を絞れる */
  | { t: 'createToken'; token: TokenRef; count?: Value; equip?: boolean; owner?: PlayerSel; mark?: string }
  | { t: 'destroyToken'; tokens: TokenSel; to?: ZoneRef }
  | { t: 'createMinion'; species: SpeciesRef; count: Value; owner?: PlayerSel }
  | { t: 'sacrificeMinion'; species: SpeciesRef; count: Value; owner?: PlayerSel }
  // ---- 状態 ----
  | { t: 'gainStatus'; player: PlayerSel; kind: StatusKind; amount: Value; duration?: Duration; capFromThisSource?: Value }
  | { t: 'addPlayerCounter'; kind: CounterKind; to: PlayerSel; amount: Value }
  | { t: 'setWeather'; weather: Weather | { t: 'choose'; side?: 'front' | 'back' } | { t: 'random'; side?: 'front' | 'back' }; ifAlreadyThen?: Weather; flipToBack?: boolean }
  | { t: 'grantContinuous'; mod: ContinuousMod; duration: Duration; to?: PlayerSel; onceOnly?: boolean; cond?: Condition }
  | { t: 'grantTrigger'; trigger: GrantedTrigger; duration: Duration; to?: PlayerSel; onceOnly?: boolean }
  /**
   * 値または選択結果をスタック項目に記録する。
   * let の束縛が1つの効果ツリー内で閉じるのに対し、snapshot は**その項目が存在する間ずっと残り、
   * 同じ項目の別の ability から参照できる**。
   * 「スタックに乗せたとき種類を選び、解決時にその種類を参照する」（最期の献身・加護の紋章）や
   * 「乗せたときライフを記録し、解決時に一致を判定する」（海の抱擁）で使う。
   */
  | { t: 'snapshot'; name: string; value?: Value; select?: Selection }
  | { t: 'revealObjective'; player: PlayerSel; which?: Value }
  | { t: 'win'; player: PlayerSel }
  | { t: 'lose'; player: PlayerSel }
  // ---- 制御構造 ----
  | { t: 'seq'; of: Effect[] }
  | { t: 'repeat'; count: Value; body: Effect }
  | { t: 'if'; cond: Condition; then: Effect; else?: Effect }
  | { t: 'forEach'; of: StackSel | CardSel | PlayerSel; as: string; body: Effect }
  | { t: 'optional'; chooser: PlayerSel; body: Effect }
  | { t: 'modal'; chooser: PlayerSel; count?: Value; modes: { text: string; effect: Effect }[] }
  /** 「カードを1枚捨てるたび、これを繰り返してもよい」— 支払いつきの任意反復 */
  | { t: 'while'; chooser: PlayerSel; cost?: Effect; body: Effect; max?: Value }
  /**
   * 効果を実行し、その結果を束縛する。
   * damage → 与えたダメージ量 / draw → 引いた枚数 / discard → 捨てた枚数 /
   * createMinion → 生成数 / moveCards・moveStackToZone → 対象の集合と枚数
   * Value 位置で {t:'var'} を読むと数値、Selector 位置で読むと対象の集合になる。
   */
  | { t: 'bind'; name: string; of: Effect; then: Effect }
  /**
   * 「選ぶ」だけを行い、結果を束縛する（何も起きない）。
   * 「選んだ種類とは違う種類」「瞬発を持つカードを選ぶなら」のように
   * 選択の結果を後続が参照する必要がある効果で使う。
   */
  | { t: 'let'; name: string; select: Selection; then: Effect }
  | { t: 'nothing' }
  // ---- 逃げ道 ----
  | { t: 'handler'; id: string; params?: Record<string, Value | string | boolean> };

export type TokenRef =
  | string
  | { t: 'choose'; kind?: TokenKind | TokenKind[]; chooser?: PlayerSel; excludeRelic?: boolean; excludeEquipped?: boolean }
  | { t: 'var'; name: string };

/**
 * let で束縛できる対象。束縛名は各 Selector の {t:'var', name} で読み出す。
 * 数値として読むときは Value の {t:'var'}（数値束縛）か {t:'countOf'}（集合の要素数）。
 */
export type Selection =
  | { of: 'stack'; sel: StackSel }
  | { of: 'card'; sel: CardSel }
  | { of: 'token'; sel: TokenSel }
  | { of: 'species'; sel: SpeciesRef }
  | { of: 'entity'; sel: EntitySel }
  | { of: 'player'; sel: PlayerSel }
  | { of: 'number'; value: Value };

// ============================================================
// 6. 継続的効果 / 置換効果（ContinuousMod）
// ============================================================

export type ContinuousMod =
  /** ダメージを軽減する。軽減するたび onApply を実行できる */
  | { t: 'damageReduction'; amount: Value; who: PlayerSel; sourceFilter?: StackFilter; tags?: DamageTag[]; species?: SpeciesFilter; onApply?: Effect }
  /** ダメージを完全に無効化する（不壊剛壁・天候免疫） */
  | { t: 'damagePrevention'; who: PlayerSel; sourceFilter?: StackFilter; tags?: DamageTag[]; species?: SpeciesFilter; weather?: Weather | Weather[] }
  /** 与える/受けるダメージへの加減算 */
  | { t: 'damageDelta'; amount: Value; who: PlayerSel; direction: 'dealt' | 'taken'; tags?: DamageTag[]; species?: SpeciesFilter; sourceFilter?: StackFilter }
  | { t: 'damageMultiplier'; factor: Value; tags?: DamageTag[]; sourceFilter?: StackFilter }
  /** ダメージにフラグを付与する（「あなたが刺突を行うなら、それは軽減されない」） */
  | { t: 'damageFlagGrant'; who: PlayerSel; tags?: DamageTag[]; species?: SpeciesFilter; sourceFilter?: StackFilter; flags: DamageFlags }
  /** ライフが0以下になるのを肩代わりする（根性） */
  | { t: 'lethalReplacement'; who: PlayerSel; setLifeTo: Value; then?: Effect }
  /** ダメージの着弾先を差し替える（防御指令のミニオン割り振り） */
  | { t: 'damageRedirect'; who: PlayerSel; to: EntitySel; overflow?: 'carry' | 'absorb' }
  /** ドロー枚数の置換 */
  | { t: 'drawDelta'; amount: Value; who: PlayerSel; onlyFromCardEffect?: boolean }
  /** 手札上限の変更 */
  | { t: 'handLimit'; amount: Value | 'none'; who: PlayerSel }
  /** 対象に取られない */
  | { t: 'untargetable'; items?: StackSel; who?: PlayerSel; minions?: SpeciesRef }
  /** 指定の天候の効果を受けない */
  | { t: 'weatherImmune'; who: PlayerSel; weather: Weather | Weather[] }
  /**
   * 汎用の置換効果。when のイベントが起きようとするとき、代わりに with を行う。
   * with を省略すると単に打ち消す。optional なら「代わりに〜してもよい」。
   * 雷光顕現の「雷雲によるカード無効化が行われるなら、代わりにミニオン1体を生贄にしてもよい」用。
   */
  | { t: 'replaceEvent'; when: TriggerEvent; with?: Effect; optional?: boolean; who?: PlayerSel }
  /** 相手の天候変更を打ち消す（回数制限つき） */
  | { t: 'preventWeatherChange'; by: PlayerSel; times?: Value }
  /** キーワードを付与する（「瞬発を持つかのようにプレイしてよい」） */
  | { t: 'grantKeyword'; keyword: Keyword; scope: 'nextPlay' | 'allPlays'; who: PlayerSel; cost?: Effect }
  /** 代替プレイ手段を与える（クルーエルカーネイジ） */
  | { t: 'alternativePlay'; who: PlayerSel; cost: Effect; play: StackPayload }
  /** 相手の手札を公開させる */
  | { t: 'revealHand'; who: PlayerSel }
  /** サイクルボーナスを無視 */
  | { t: 'ignoreCycleBonus' }
  | { t: 'handler'; id: string; params?: Record<string, Value | string | boolean> };

// ============================================================
// 7. 誘発（Trigger）
// ============================================================

export type EventKind =
  | 'played'
  | 'placedOnStack'   // 相手がこのカードの上に乗せた、など位置を伴う配置
  | 'resolved'
  | 'resolving'       // 解決しようとするたび
  | 'countered'
  | 'reordered'
  /** スタックから手札に戻された（バウンス） */
  | 'bounced'
  | 'counterChanged'
  | 'damageDealt'
  | 'damageTaken'
  | 'lifeChanged'
  | 'drawn'
  | 'discarded'
  | 'foreseen'
  | 'weatherChanged'
  | 'tokenCreated'
  | 'minionCreated'
  | 'minionDied'
  | 'minionSacrificed'
  /** 雷雲によるカードのランダム無効化が行われようとしている */
  | 'weatherNegate'
  | 'cycleStart'
  | 'turnEnd'
  | 'orderPhaseStart'
  | 'resolveStart'
  /** 特殊勝利条件が公開された（サイクル開始の公開、カードによる強制公開） */
  | 'objectiveRevealed';

/**
 * 誘発の粒度。
 *
 * 既定は 'perEvent' — **1回の効果につき1回**発火する。
 * 「カードを2枚引く」は drawn を1回だけ発火させ、引いた枚数は暗黙束縛 `count` で参照する。
 * （設定シート スウィフトマニューバー「複数枚引いても1」がこの既定を要求している）
 *
 * 'perUnit' を明示したときだけ、1枚／1体ごとに発火する。
 * 'perSpecies' はミニオン専用で、種族1つにつき1回発火する
 * （奥義枠「ミニオンが**1種類**死亡するか生成されるたび」）。
 */
export type TriggerGranularity = 'perEvent' | 'perUnit' | 'perSpecies';

export interface TriggerEvent {
  /** 複数指定で「〜するか〜するたび」を1つの誘発として書ける */
  on: EventKind | EventKind[];
  /** 誰/何に起きたときか。省略時は「このカード自身」 */
  subject?: StackSel | PlayerSel | EntitySel;
  filter?: StackFilter;
  tags?: DamageTag[];
  cond?: Condition;
  /** 種族で絞る（「人でダメージを与えたとき」「死霊以外が死亡したとき」） */
  species?: SpeciesFilter;
  /** 既定 'perEvent'（1回の効果につき1回） */
  granularity?: TriggerGranularity;
}

/**
 * 誘発効果の中で使える暗黙束縛。
 * `{ t:'var', name:'count' }` のように、明示的な bind/let なしで参照できる。
 * 名前はイベント種別ごとに固定で、エンジンが誘発を実行する直前に束縛する。
 *
 *  played / placedOnStack / resolved / resolving / countered / reordered
 *      source  … 発生源のスタック項目
 *  counterChanged
 *      source / count（変化後の値）/ delta（増減量）
 *  damageDealt / damageTaken
 *      source / amount（実際に通ったダメージ）/ target
 *  lifeChanged
 *      delta
 *  drawn / discarded / foreseen
 *      count（枚数）/ cards（対象の集合）
 *  minionCreated / minionDied
 *      species（種族）/ count（体数）
 *  tokenCreated
 *      token
 *  weatherChanged
 *      from / to
 *
 * 継続的効果の内部にも同種の規約がある:
 *  ContinuousMod damageReduction.onApply → reduced（実際に軽減した量）
 */
export type ImplicitBinding =
  | 'source' | 'count' | 'delta' | 'amount' | 'target'
  | 'cards' | 'species' | 'token' | 'from' | 'to' | 'reduced';

export interface Limit {
  count: number;
  per: 'turn' | 'cycle' | 'game';
}

export interface GrantedTrigger {
  when: TriggerEvent;
  effect: Effect;
  optional?: boolean;
  limit?: Limit;
}

// ============================================================
// 8. 能力（Ability）
// ============================================================

export type ActiveWhere = 'onStack' | 'inHand' | 'inField' | 'always';

export type Ability =
  | { kind: 'onPlay'; effect: Effect; limit?: Limit }
  | { kind: 'onResolve'; effect: Effect }
  | { kind: 'triggered'; active: ActiveWhere; when: TriggerEvent; effect: Effect; optional?: boolean; limit?: Limit }
  | {
      kind: 'activated';
      active: ActiveWhere;
      timing: 'stackPhase' | 'orderPhase' | 'anytimeThisRound' | 'anytime';
      cost?: Effect;
      effect: Effect;
      limit?: Limit;
    }
  | { kind: 'continuous'; active: ActiveWhere; cond?: Condition; mod: ContinuousMod }
  /**
   * 閾値誘発の糖衣構文。
   * 「詠唱が3になったら2点、6になったら5点、9になったら軽減不可13点」のように
   * 同じカウンタの複数の閾値に効果がぶら下がる形を1つにまとめる。
   * triggered（counterChanged + cmp '=='）を steps の数だけ並べたものと等価。
   */
  | {
      kind: 'thresholds';
      active: ActiveWhere;
      counter: CounterKind;
      /** 既定はこのカード自身 */
      on?: StackSel;
      /** 各閾値は上昇して到達した瞬間に1度だけ発火する */
      steps: { at: number; effect: Effect }[];
    };

// ============================================================
// 9. プレイ制約
//    ほぼ全てのカードが何らかの制約を持つため CardDef の一級市民にする。
// ============================================================

export interface PlayRule {
  /** プレイできる条件（「ライフが対戦相手より少なく、手札が2枚以下のとき」） */
  cond?: Condition;
  /** 追加コスト（「手札からカードを1枚捨てることでプレイできる」） */
  cost?: Effect;
  /** プレイ回数制限（「1サイクルに1枚しかプレイできない」） */
  limit?: Limit;
  /** プレイできるタイミング（既定はスタックフェイズ。騙し討ちは順番確定フェイズ） */
  timing?: ('stackPhase' | 'orderPhase')[];
  /** 「あなたのサイクルの初めにプレイするカードでなければならない」 */
  mustBeFirstOfCycle?: boolean;
  /** 置ける位置の制約（相殺：相手のダメージを与えるスタックの上にのみ） */
  positionRequires?: StackFilter;
}

// ============================================================
// 10. カード / トークン / 勝利条件の定義
// ============================================================

export interface CardDef {
  id: string;
  name: string;
  god: God;
  types: string[];
  /** 印刷テキスト。人が書いたものが正（DSLから自動生成はしない） */
  text: string;
  keywords?: Keyword[];
  /** 待機値・優先度（現状は保留。採用時に使う） */
  wait?: number;
  priority?: number;
  ignoresCycleBonus?: boolean;
  /** 「このカードはスタック上で位置を変えることができない」 */
  immovable?: boolean;
  play?: PlayRule;
  abilities: Ability[];
  /** 設計メモ（企画書の「カードの狙い」列） */
  note?: string;
}

export interface TokenDef {
  id: string;
  name: string;
  god: God;
  kind: TokenKind;
  text: string;
  /** 「これは1つしか装備できない」 */
  unique?: boolean;
  /** 「同じ装備は3つまで同時に生成できる」 */
  maxCopies?: number;
  abilities: Ability[];
  note?: string;
}

/**
 * ミニオンは**種族ごとの数だけ**で管理する（確定仕様）。
 * 個体を表す ID も、体力も、攻撃力も持たない。盤面上の状態は MinionPool（種族→体数）だけ。
 * 「ミニオン1体」を対象に取る効果は存在せず、常に「種族」と「数」で指定する。
 */
export interface MinionDef {
  species: Species;
  name: string;
  text: string;
  abilities: Ability[];
}

/** 盤面上のミニオンの全状態。種族 → 体数 */
export type MinionPool = Record<Species, number>;

export interface ObjectiveDef {
  id: string;
  name: string;
  god: God;
  /** 先行度。1に近いほど先攻。'special' は創造の神の特殊枠 */
  initiative: number | 'special';
  text: string;
  /** 勝利判定を行うタイミング */
  when: TriggerEvent | { on: 'continuous' };
  cond?: Condition;
  /**
   * 勝利以外の効果を持つ条件（創造の神など）。
   * **省略した条件は「この条件の持ち主が勝利する」の意味になる。**
   */
  effect?: Effect;
  /**
   * 発火回数の制限。
   * `when` が `{on:'continuous'}` の条件は成立している間ずっと真なので、
   * 省略時は **1ゲームに1回**（`CONTINUOUS_DEFAULT_LIMIT`）が適用される。
   * 誘発型（`when` が `TriggerEvent`）は省略時は無制限で、通常の誘発と同じ。
   */
  limit?: Limit;
  /** 公開されている間の常在効果（パッシブ勝利条件） */
  passive?: ContinuousMod;
  /** 設計メモ（企画書のコメントと、データ化にあたっての判断） */
  note?: string;
}

/**
 * 神ごとの定義。カードに属さない神固有の常時能力・初期セットアップを持つ。
 * 大地の「攻勢」「難攻不落」、海の予知領域、生命の「ターン開始時に全種2体生成」など、
 * カードプールに置き場のなかったものの受け皿。
 */
export interface GodDef {
  id: God;
  name: string;
  /** 常時働く神のパッシブ能力 */
  passives: Ability[];
  /** この神が使える NamedAction のID */
  actions: string[];
  /** この神が使えるミニオン種族 */
  species?: Species[];
  /** この神が生成できるトークンのID */
  tokens?: string[];
  note?: string;
}

/** カードプール全体 */
export interface CardPool {
  gods: GodDef[];
  cards: CardDef[];
  tokens: TokenDef[];
  minions: MinionDef[];
  actions: NamedActionDef[];
  objectives: ObjectiveDef[];
}
