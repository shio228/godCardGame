/**
 * 特殊勝利条件（`ObjectiveDef`）のデータ。
 *
 * 出典は企画書「基本システム」C55〜C111 の一覧。
 * 各神は候補の中から**3つ**を採用する（企画書「採用する最低数は3つ」）。
 * ここには**先行度の仮配分が振られている3つずつ**を載せている。
 *   大地 1 / 3 / 6　　生命 2 / 8 / 12　　空 4 / 7 / 9　　海 5 / 10 / 15
 * 数値が未定のもの（「ミニオンをn体以上」「除外枚数がn以上」）と、
 * 創造の神（公開ルールが調整中）は入れていない。
 *
 * 先行度は**全神を通して一意**でなければならない（企画書「先行度は同じ数字を持たない」）。
 * 上の16個は 0〜15 のうち創造の 0/11/13/14 を除いた12個で、重複はない。
 *
 * `text` は企画書の文面をそのまま写している。`note` に企画書のコメントと、
 * データ化にあたって判断した点を残した。
 */
import type { Condition, ObjectiveDef, Value } from './types';

/** 「その名前のトークンを1つ以上コントロールしている」 */
function hasToken(name: string): Condition {
  return { t: 'cmp', a: { t: 'countTokens', filter: { name, owner: { t: 'self' } } }, op: '>=', b: 1 };
}

function atLeast(a: Value, b: Value): Condition {
  return { t: 'cmp', a, op: '>=', b };
}

// ============================================================
// 大地の神 — アグロ / 強化オーラ　先行度配分：高（1 / 3 / 6）
// ============================================================

/** 先行度高「10回目のダメージを与えたなら勝利する。」 */
export const earthTenStrikes: ObjectiveDef = {
  id: 'earth/obj_ten_strikes',
  name: '十連撃の誓約',
  god: 'earth',
  initiative: 1,
  text: 'あなたが10回目のダメージを与えたなら、勝利する。',
  when: { on: 'damageDealt' },
  cond: atLeast(
    {
      t: 'countEvent',
      event: 'damageDealt',
      scope: 'game',
      measure: 'events',
      by: { t: 'self' },
      to: { t: 'opponent' },
    },
    10,
  ),
  note:
    '企画書の改訂案①は「この勝利条件を公開したターンに15回」（scope を turn に、10 を 15 に）。\n' +
    'measure:"events" は回数なので、軽減しきられて0点だったダメージも1回と数える。' +
    '企画書には「0ダメでも数えるから納得いかないかも」というコメントがあるが、' +
    '**0点でも1回と数える**で確定（企画側の判断・2026-08-31）。\n' +
    '`to:"opponent"` が要る。これが無いと**自傷まで数える**——ブレイジングラッシュの' +
    '「カードをプレイするたび2点受ける」で、スタックフェイズにカードを並べるだけで達成してしまう' +
    '（2026-09-06 のテストプレイで発覚）。企画書「基本システム」の原文は' +
    '「槍連打・戦技で刺突・n回命中したら」という攻撃回数の文脈。',
};

/** 先行度高「3種類の武器、2種類の防具をコントロールし、打撃でダメージを与えたなら勝利する」 */
export const earthFullArsenal: ObjectiveDef = {
  id: 'earth/obj_full_arsenal',
  name: '完全武装の証明',
  god: 'earth',
  initiative: 3,
  text: 'あなたが3種類の武器と2種類の防具をコントロールし、打撃でダメージを与えたなら、勝利する。',
  when: { on: 'damageDealt', tags: ['strike'] },
  cond: {
    t: 'and',
    of: [
      hasToken('インフェルノフューリー（剣）'),
      hasToken('ヴァーミリオンピアス（槍）'),
      hasToken('グランドデストラクション（槌）'),
      hasToken('黒曜備え'),
      hasToken('灼熱の外套'),
    ],
  },
  note:
    '「3種類」「2種類」は**種類数**なので、countTokens の kind では数えられない' +
    '（剣は maxCopies:3 なので剣を3つ持っただけで「武器3種類」になってしまう）。名前で1つずつ検査している。\n' +
    '現在のトークンは武器が剣・槍・槌の3種、防具が黒曜備え・灼熱の外套の2種で、' +
    'つまり**大地の装備を全種類そろえる**のがこの条件。装備が増えたらここも直す必要がある。\n' +
    'グランドデストラクションは TokenDef 上 kind:"relic"（神器）だが、企画書の「剣、槍、槌＋神器」の書き方に従って' +
    '武器3種の1つとして数えている。神器を武器と別枠にするなら要変更。',
};

/** 先行度中「あなたが1度の攻撃で8点のダメージを与えたなら勝利する。」 */
export const earthSingleBlow: ObjectiveDef = {
  id: 'earth/obj_single_blow',
  name: '一撃必殺',
  god: 'earth',
  initiative: 6,
  text: 'あなたが1度の攻撃で8点のダメージを与えたなら、勝利する。',
  when: { on: 'damageDealt' },
  cond: atLeast({ t: 'var', name: 'amount' }, 8),
  note:
    '企画書に「のちのち変更必須！→10ポイントぐらいなら適正」「10どころか8でも相手が死ぬのでは」のコメントあり。\n' +
    '**軽減後（実際に通ったダメージ）で判定する**で確定（企画側の判断・2026-08-31）。' +
    '暗黙束縛 amount がその値なので、そのまま使っている。' +
    '設計書§5の用語では「与えたダメージ」は軽減前だが、ここは相手が軽減で防げる側を採る。',
};

// ============================================================
// 海の神 — コントロール　先行度配分：中〜低（5 / 10 / 15）
// ============================================================

/** 「スタック上で詠唱の合計数が一定以上になったら勝利する」 */
export const seaChantThirty: ObjectiveDef = {
  id: 'sea/obj_chant_thirty',
  name: '詠唱の極致',
  god: 'sea',
  initiative: 5,
  text: 'スタック上の詠唱カウンターの合計が30以上になったなら、あなたは勝利する。',
  when: { on: 'counterChanged', subject: { t: 'each' } },
  cond: atLeast({ t: 'counters', kind: 'chant', on: { t: 'all', filter: { scope: 'allStacks' } } }, 30),
  note:
    '企画書は「仮：30以上　→　7連続詠唱なら28詠唱のはず」。\n' +
    '企画書では先行度欄が空欄だったので、海の仮配分 5/10/15 のうち残った 5 を当てた。\n' +
    'スタックが分割される（並列思考）場合も合算したいので filter.scope を allStacks にしてある。',
};

/** 先行度低「自分のターンが終了したとき、手札が15枚なら勝利する。」 */
export const seaFifteenCards: ObjectiveDef = {
  id: 'sea/obj_hand_fifteen',
  name: '叡智の飽和',
  god: 'sea',
  initiative: 10,
  text: 'あなたのターンが終了したとき、あなたの手札がちょうど15枚なら、勝利する。',
  when: { on: 'turnEnd' },
  cond: { t: 'cmp', a: { t: 'countZone', of: { zone: 'hand', owner: { t: 'self' } } }, op: '==', b: 15 },
  note:
    '企画書に「枚数は変えてよい。叡智保管庫がなくても氾濫スプリットあれば達成可」。\n' +
    '手札上限は10枚なので、叡智保管庫（手札を何枚でも持ち越せる）が前提の条件。',
};

/** 先行度低「自分のターン開始時、ライフがちょうど35なら勝利する。」 */
export const seaLifeThirtyFive: ObjectiveDef = {
  id: 'sea/obj_life_thirtyfive',
  name: '完全なる水位',
  god: 'sea',
  initiative: 15,
  text: 'あなたのターン開始時、あなたのライフがちょうど35なら、勝利する。',
  when: { on: 'cycleStart' },
  cond: { t: 'cmp', a: { t: 'life', of: { t: 'self' } }, op: '==', b: 35 },
  note:
    '企画書に「30〜40の範囲だと最初のターンのウォーターや叡智調整が狙いやすい」。\n' +
    '「ターン開始時」はサイクル開始フェイズと読んで cycleStart にしている。' +
    'サイクル開始は勝利条件の公開のあとなので、公開したそのサイクルから判定される。',
};

// ============================================================
// 空の神 — コンボ / ソリティア　先行度配分：中（4 / 7 / 9）
// ============================================================

/** 先行度中「あなたがコントロールする効果が一度に15個スタックに乗せられたとき、勝利する。」 */
export const skyFifteenEffects: ObjectiveDef = {
  id: 'sky/obj_fifteen_effects',
  name: '無限連鎖',
  god: 'sky',
  initiative: 4,
  text: 'あなたがコントロールする効果が一度に15個スタックに乗せられたとき、勝利する。',
  when: { on: 'placedOnStack' },
  cond: atLeast(
    { t: 'countStack', filter: { controller: { t: 'self' }, kind: 'effect', scope: 'allStacks' } },
    15,
  ),
  note:
    '「効果」はスタック項目の kind:"effect"（生成された効果）として数えている。' +
    'カードそのものは含めない読み。カードも数えるなら kind を外す。\n' +
    '「一度に」は「同時にスタック上に15個ある」と読んだ（累計ではない）。',
};

/** 先行度中「このゲーム中、累計で20回天候が変わったなら、勝利する。」 */
export const skyTwentyWeathers: ObjectiveDef = {
  id: 'sky/obj_twenty_weathers',
  name: '天象二十変',
  god: 'sky',
  initiative: 7,
  text: 'このゲーム中、累計で20回天候が変わったなら、あなたは勝利する。',
  when: { on: 'weatherChanged', subject: { t: 'each' } },
  cond: atLeast({ t: 'countEvent', event: 'weatherChanged', scope: 'game', measure: 'events' }, 20),
  note:
    '企画書に「11/28時点 任意表3種9枚、裏にする3枚、雷にする3枚、凪にする特殊勝利で18枚」。\n' +
    'measure:"events" は回数（明鏡止水・セレスティアルディザスターと同じ数え方）。' +
    'by を指定していないので**どちらが変えた天候でも数える**。「あなたが変えた分だけ」なら by:self を足す。',
};

/** 「あなたのカードがスタック上で7枚連続していたなら勝利」（企画書に併記された代案） */
export const skySevenRun: ObjectiveDef = {
  id: 'sky/obj_seven_run',
  name: '連鎖する空',
  god: 'sky',
  initiative: 9,
  text: 'あなたのカードか効果がスタック上で7つ連続していたなら、あなたは勝利する。',
  when: { on: 'placedOnStack' },
  cond: atLeast({ t: 'consecutiveRun', from: { t: 'top' }, controller: { t: 'self' }, includeSelf: true }, 7),
  note:
    '企画書では「無限コンボ」の欄に併記された代案（「または、『あなたのカードがスタック上で7枚連続していたなら勝利』' +
    'のようなものはどうか」）。空は先行度が3つ振られているのに条件が2つしか確定していないので、これを3つ目に当てた。\n' +
    'consecutiveRun はスタックの一番上から下に向かって同一コントローラーが続く数を数える。' +
    '実装は thisStack 固定なので、スタックが分割されている場合は最初のスタックだけを見る。',
};

// ============================================================
// 生命の神 — ビートダウン / トークン　先行度配分：バラバラ（2 / 8 / 12）
// ============================================================

/** 先行度高「ターン開始時、あなたのライフが99点以上なら勝利する。」 */
export const lifeNinetyNine: ObjectiveDef = {
  id: 'life/obj_life_99',
  name: '生命の氾濫',
  god: 'life',
  initiative: 2,
  text: 'あなたのターン開始時、あなたのライフが99点以上なら、勝利する。',
  when: { on: 'cycleStart' },
  cond: atLeast({ t: 'life', of: { t: 'self' } }, 99),
  note: '初期ライフは30、上限は無限（企画書「初期HP30／最大は無限」）。',
};

/** 先行度中「お互いのライフが50回以上変動したとき、勝利する」 */
export const lifeFiftySwings: ObjectiveDef = {
  id: 'life/obj_fifty_swings',
  name: '生死の振幅',
  god: 'life',
  initiative: 8,
  text: 'お互いのライフが合計50回以上変動したとき、あなたは勝利する。',
  when: { on: 'lifeChanged', subject: { t: 'each' } },
  cond: atLeast({ t: 'countEvent', event: 'lifeChanged', scope: 'game', measure: 'events' }, 50),
  note:
    '企画書に「ドレイン：相手減る、自分回復が2で数えたりする想定」。' +
    'by を指定していないので両者の変動を合計して数える＝この想定どおり。\n' +
    'measure:"events" は回数。1回の効果で何点動いても1と数える。',
};

/**
 * 先行度低「あなたが5種類以上の種族をコントロールしているなら勝利する。」
 * → 企画書のアレンジ案「4種類それぞれ何体以上」を採用し、**4種類それぞれ5体以上**とした。
 */
export const lifeAllSpecies: ObjectiveDef = {
  id: 'life/obj_all_species',
  name: '万象の軍勢',
  god: 'life',
  initiative: 12,
  text: 'あなたが人間・天使・死霊・獣をそれぞれ5体以上コントロールしているなら、勝利する。',
  when: { on: 'continuous' },
  cond: {
    t: 'and',
    of: [
      atLeast({ t: 'countMinions', species: 'human', of: { t: 'self' } }, 5),
      atLeast({ t: 'countMinions', species: 'angel', of: { t: 'self' } }, 5),
      atLeast({ t: 'countMinions', species: 'wraith', of: { t: 'self' } }, 5),
      atLeast({ t: 'countMinions', species: 'beast', of: { t: 'self' } }, 5),
    ],
  },
  note:
    '企画書の原文は「5種類以上の種族をコントロールしているなら勝利」だが、現在ミニオンは4種類' +
    '（人間・天使・死霊・獣）しかなく**そのままでは達成不可能**。企画書のアレンジ案' +
    '「4種類それぞれ何体以上とかのアレンジが利く」を採用し、4種類それぞれ5体以上とした。' +
    '**5体はテスト段階の仮の数値**で、変わる前提。\n' +
    '「〜しているなら」なので when は continuous（盤面を見れば真偽が決まり、成立の原因を列挙できない）。\n' +
    '種族を書き並べているのは、「いまコントロールしている種族の種類数」を数える Value が DSL に' +
    '無いため（countSpeciesKinds はイベント履歴から種類を数えるもので盤面を見ない）。' +
    '種族が増えたらここも足す。種類数で書けるようにするなら Value の追加が要る。',
};

// ============================================================

export const sampleObjectives: ObjectiveDef[] = [
  earthTenStrikes,
  earthFullArsenal,
  earthSingleBlow,
  seaChantThirty,
  seaFifteenCards,
  seaLifeThirtyFive,
  skyFifteenEffects,
  skyTwentyWeathers,
  skySevenRun,
  lifeNinetyNine,
  lifeFiftySwings,
  lifeAllSpecies,
];

/**
 * データ化を見送った候補（企画書には文面があるが、数値未定か現状のDSLで書けないもの）:
 *
 * 大地
 *   - 「このターン発生したダメージを全て0まで軽減できたら勝利」
 *     書ける（turnEnd + countEvent damageTaken units==0）が、先行度の枠が3つとも埋まったので保留。
 *     「一度もダメージを受けていない」場合も成立してしまう点は要判断。
 * 海
 *   - 「初期山札40枚以上。山札が0のときドローを行ったなら敗北の代わりに勝利する」
 *     引き切りペナルティは「30点ダメージをスタックに追加」であって即敗北ではないので
 *     「敗北の代わりに」が噛み合わない。デッキ構築制約の表現も無い。
 *   - 「天候が雨の状態が2サイクル継続したとき勝利」企画書に「どこで判定するか」と未決の書き込みあり。
 *   - 「このターンに4つの場所からカードを手札に加えたなら勝利」カードの由来ゾーンを追跡する仕組みが無い。
 *   - 「除外枚数がn以上的な要素」文面・数値ともに未確定。
 * 空
 *   - 「手札が7枚以上で始まったターン中に手札が0になったらカウンター、3以上で勝利」
 *     企画書に「色々システム変更した結果ちょっと不可能っぽい雰囲気が」とある。
 * 生命
 *   - 「このターン終了時にミニオン合計数が40（仮）以上なら」
 *     書ける（turnEnd + countMinions >= 40）が、先行度の枠が3つとも埋まったので保留。
 *   - 「このターンにミニオンをn体以上作ったら」「n体以上生贄にささげたら」n が未定。
 * 創造
 *   - 公開ルールそのものが調整中のため全件見送り。
 *     エンジン側も特殊な公開（複数選んで最も先行度の低いものだけ公開／公開できない条件／
 *     先行度0＝他を選べず必ず先攻・初期手札5枚）に未対応。
 */
