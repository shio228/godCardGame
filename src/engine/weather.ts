/**
 * 天候の能動効果。
 *
 * 企画書「基本システム」の天候表がそのままここに載っている:
 *
 * | 表 | 裏 | 効果 |
 * |---|---|---|
 * | 晴 | 炎天 | 晴: 攻撃が必ず当たる / 炎天: 攻撃が必ず当たる。カードをプレイする時とスタックを解決する時、そのコントローラーに1ダメージ（ダメボ非適用） |
 * | 雨 | 豪雨 | 雨: サイクルボーナス無視 / 豪雨: サイクルボーナス無視。カードをプレイするごとに手札を1枚捨てる |
 * | 吹雪 | 雷雲 | 吹雪: ターン終了時に両者へ5ダメージ（ダメボ非適用） / 雷雲: スタックのカードを1枚ランダムに無効化（順番確定と解決の間） |
 * | 凪 | 終末 | 凪: 特になし / 終末: ターン開始時に山札を1つ選び上から5枚除外 |
 *
 * **設計判断（roadmap 優先度2）**: フェイズ処理にベタ書きせず、天候ごとの定義テーブルを持ち、
 * そこから `GrantedTrigger` / 判定フラグを供給する。天候ダメージが既存の
 * `dealDamage` と `activeMods` の経路にそのまま乗るので、軽減・回避・免疫との
 * 相互作用を二重に書かずに済む。
 *
 * 注入ではなく**収集**にした点だけ roadmap の書き方と違う。`state` に注ぎ込むと
 * 天候が変わるたびに古い分を回収する必要があり、取りこぼすと幽霊の天候効果が残る。
 * `gatherSources` と同じく「いま有効なものをその都度集める」形にしてある。
 */
import type { DamageFlags, Effect, GrantedTrigger, PlayerId, StackSel, Weather } from '../rules/types';
import { isWeatherImmune } from './continuous';
import { logAction, type Ctx, type Engine } from './context';
import { itemName } from './select';
import { rngInt, type StackItem } from './state';

const PLAYERS: PlayerId[] = ['P1', 'P2'];

/**
 * 天候が与えるダメージのフラグ。
 * 「天候から与えられるダメージはそれ用のカードがない限り軽減できず、回避できない」
 * （企画書「基本ルール」）。`damagePrevention` / `weatherImmune` を持つカードだけが防げる。
 * サイクルボーナスは `tags:['weather']` で `damage.ts` 側も落としているが、
 * 発生源側でも明示しておく。
 */
export const WEATHER_DAMAGE_FLAGS: DamageFlags = {
  ignoreCycleBonus: true,
  unreducible: true,
  unavoidable: true,
};

/** 「自分がコントロールしているスタック項目」— 炎天・豪雨の誘発を自分の分だけに絞る */
const MY_ITEMS: StackSel = { t: 'all', filter: { controller: { t: 'self' }, scope: 'allStacks' } };

function weatherDamage(amount: number): Effect {
  return {
    t: 'damage',
    to: { t: 'player', who: { t: 'self' } },
    amount,
    tags: ['weather'],
    flags: WEATHER_DAMAGE_FLAGS,
  };
}

export interface WeatherDef {
  name: string;
  /** サイクルダメージボーナスが乗らない（雨・豪雨） */
  noCycleBonus?: boolean;
  /** 「攻撃が必ず当たる」= 回避が働かない（晴・炎天） */
  noEvasion?: boolean;
  /** 順番確定フェイズと解決フェイズの間に、各スタックからランダムに無効化する枚数（雷雲） */
  negatePerStack?: number;
  /**
   * その天候が起こす処理。**プレイヤーごとに1組ずつ**有効になる
   * （`{t:'self'}` はそのプレイヤーを指す）。
   */
  triggers?: GrantedTrigger[];
}

export const WEATHER_DEFS: Record<Weather, WeatherDef> = {
  calm: { name: '凪' },

  clear: { name: '晴', noEvasion: true },

  blaze: {
    name: '炎天',
    noEvasion: true,
    triggers: [
      {
        // 「カードをプレイする時と、スタックを解決する時」。
        // 解決側が resolved ではなく resolving なのは FAQ の確定事項
        //（「炎天・燃え盛るのダメージはスタックを解決しようとしたときに飛ばす」）。
        when: { on: ['played', 'resolving'], subject: MY_ITEMS },
        effect: weatherDamage(1),
      },
    ],
  },

  rain: { name: '雨', noCycleBonus: true },

  downpour: {
    name: '豪雨',
    noCycleBonus: true,
    triggers: [
      {
        when: { on: 'played', subject: MY_ITEMS },
        effect: { t: 'discard', player: { t: 'self' }, count: 1 },
      },
    ],
  },

  blizzard: {
    name: '吹雪',
    triggers: [
      {
        // 両者に5点。プレイヤーごとの誘発なので、処理順は誘発の規約どおり先攻 → 後攻になる。
        // 「吹雪による同時死亡の際は先行度が早い方が敗北」（企画書）がこれで成立する。
        when: { on: 'turnEnd' },
        effect: weatherDamage(5),
      },
    ],
  },

  thundercloud: { name: '雷雲', negatePerStack: 1 },
};

/**
 * 終末。天候の表裏の枠外（`GameState.apocalypse`）なので `WEATHER_DEFS` とは別に持つ。
 * 2サイクル目の終了フェイズに発生し、以後書き換えられない。
 */
export const APOCALYPSE_DEF: WeatherDef = {
  name: '終末',
  triggers: [
    {
      when: { on: 'cycleStart' },
      effect: {
        t: 'moveCards',
        cards: { t: 'top', from: { zone: 'deck', owner: { t: 'self' }, pile: { t: 'choose' } }, count: 5 },
        to: { zone: 'exile', owner: { t: 'self' } },
      },
    },
  ],
};

/** いまの天候（と終末）の定義 */
export function activeWeatherDefs(engine: Engine): WeatherDef[] {
  const out: WeatherDef[] = [WEATHER_DEFS[engine.state.weather]];
  if (engine.state.apocalypse) out.push(APOCALYPSE_DEF);
  return out;
}

export function weatherNoCycleBonus(weather: Weather): boolean {
  return WEATHER_DEFS[weather].noCycleBonus === true;
}

export function weatherNoEvasion(weather: Weather): boolean {
  return WEATHER_DEFS[weather].noEvasion === true;
}

export interface WeatherTriggerSource {
  controller: PlayerId;
  trigger: GrantedTrigger;
  origin: string;
  key: string;
}

/**
 * いま働いている天候の誘発を、プレイヤーごとに1組ずつ返す。`events.ts` が
 * 第6の発生源として拾う。
 *
 * **`weatherImmune` をここで落とす。** 炎天のダメージも豪雨の手札破棄も
 * この1か所で免除されるので、天候効果ごとに免疫の判定を書かずに済む
 * （天水の祝福の「豪雨の効果を受けなくなる」＝プレイ時の1枚捨てを無視する）。
 * 終末は表裏の枠外で `weatherImmune` の対象にならないため免疫の判定を通さない。
 */
export async function weatherTriggerSources(engine: Engine): Promise<WeatherTriggerSource[]> {
  const s = engine.state;
  const out: WeatherTriggerSource[] = [];
  const entries: { key: string; def: WeatherDef; immunable: boolean }[] = [
    { key: s.weather, def: WEATHER_DEFS[s.weather], immunable: true },
  ];
  if (s.apocalypse) entries.push({ key: 'apocalypse', def: APOCALYPSE_DEF, immunable: false });

  for (const { key, def, immunable } of entries) {
    const triggers = def.triggers;
    if (!triggers || triggers.length === 0) continue;
    for (const pid of PLAYERS) {
      if (immunable && (await isWeatherImmune(engine, pid))) continue;
      triggers.forEach((trigger, i) => {
        out.push({ controller: pid, trigger, origin: `天候:${def.name}`, key: `weather:${key}:${pid}#${i}` });
      });
    }
  }
  return out;
}

/**
 * 雷雲: 各スタックからカードを1枚ランダムに無効化する。
 * タイミングは「順番確定フェイズと解決フェイズの間」（企画書の天候表）なので
 * `orderPhase` の最後から呼ぶ。
 *
 * 無効化しようとしていることを `weatherNegate` イベントとして出し、
 * 置換効果（雷光顕現の「代わりにミニオンを生贄」／レイジングスカイの「対象外になる」）が
 * それを差し替えられるようにしている。
 */
export async function applyWeatherNegation(engine: Engine): Promise<void> {
  const s = engine.state;
  const n = WEATHER_DEFS[s.weather].negatePerStack ?? 0;
  if (n <= 0 || s.winner) return;

  const { emit, drainTriggers } = await import('./events');
  const { resolve } = await import('./effects');
  const { tryReplaceEvent } = await import('./continuous');
  const { Scope } = await import('./context');

  for (const st of s.stacks) {
    const cands: StackItem[] = st.items.filter((it) => it.kind === 'card');
    for (let k = 0; k < n && cands.length > 0; k++) {
      const picked = cands.splice(rngInt(s, cands.length), 1)[0]!;
      const ctx: Ctx = {
        engine,
        self: picked.controller,
        item: picked,
        stackId: picked.stackId,
        vars: new Scope(),
      };
      const ev = { kind: 'weatherNegate' as const, itemUid: picked.uid, player: picked.controller };
      await emit(ctx, ev);
      if (await tryReplaceEvent(ctx, ev)) {
        logAction(engine, 'weather', `雷雲: ${picked.uid} の無効化が置き換えられた`, picked.controller);
      } else {
        // 無効化はカードの打ち消しと同じ処理を通す（墓地送り + countered イベント）
        await resolve({ t: 'counterStack', target: { t: 'this' } }, ctx);
        logAction(engine, 'weather', `雷雲: ${itemName(ctx, picked)} を無効化`, picked.controller);
      }
      await drainTriggers(engine);
      if (s.winner) return;
    }
  }
}
