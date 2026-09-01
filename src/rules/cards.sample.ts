import type { CardDef, NamedActionDef, TokenDef, MinionDef, GodDef, CardPool } from './types';
import { sampleObjectives } from './objectives.sample';

/**
 * 表現力の検証用サンプル。
 * 出典は各神の設定シート（「カード置き場」は内容が古いので使わない）。
 * 易しいカードではなく、DSL を壊しにくるカードを優先して選んでいる。
 */

// ============================================================
// NamedAction — 戦技 / 攻撃指令 / 防御指令 / レゾナンス
// 4神に横断して現れる「神ごとの定型アクション」
// ============================================================

export const slash: NamedActionDef = {
  id: 'earth/slash',
  name: '斬撃',
  god: 'earth',
  group: 'earth/combatArt',
  text: '相手に3点のダメージを与える。',
  tags: ['slash', 'melee', 'combatArt'],
  effect: {
    t: 'damage',
    to: { t: 'player', who: { t: 'opponent' } },
    amount: 3,
    tags: ['slash', 'melee', 'combatArt'],
  },
};

export const thrust: NamedActionDef = {
  id: 'earth/thrust',
  name: '刺突',
  god: 'earth',
  group: 'earth/combatArt',
  text: '相手に1点のダメージを与える。これを2回行う。',
  tags: ['thrust', 'melee', 'combatArt'],
  effect: {
    t: 'damage',
    to: { t: 'player', who: { t: 'opponent' } },
    amount: 1,
    times: 2,
    tags: ['thrust', 'melee', 'combatArt'],
  },
};

export const strike: NamedActionDef = {
  id: 'earth/strike',
  name: '打撃',
  god: 'earth',
  group: 'earth/combatArt',
  text: '相手に軽減できない2点のダメージを与える。',
  tags: ['strike', 'melee', 'combatArt'],
  effect: {
    t: 'damage',
    to: { t: 'player', who: { t: 'opponent' } },
    amount: 2,
    tags: ['strike', 'melee', 'combatArt'],
    flags: { unreducible: true },
  },
};

export const attackOrder: NamedActionDef = {
  id: 'life/attackOrder',
  name: '攻撃指令',
  god: 'life',
  text: 'x点のダメージを与える。xはあなたが選んだ1種類のミニオンの数である。',
  tags: ['attackOrder'],
  effect: {
    t: 'let',
    name: 'sp',
    select: { of: 'species', sel: { t: 'choose', chooser: { t: 'self' }, onlyExisting: true } },
    then: {
      t: 'damage',
      to: { t: 'player', who: { t: 'opponent' } },
      tags: ['attackOrder'],
      // 「どの種族で殴ったか」をダメージに載せる（栄光の凱旋が参照する）
      species: { t: 'var', name: 'sp' },
      amount: { t: 'countMinions', of: { t: 'self' }, species: { t: 'var', name: 'sp' } },
    },
  },
};

export const defenseOrder: NamedActionDef = {
  id: 'life/defenseOrder',
  name: '防御指令',
  god: 'life',
  text:
    '常在＜あなたがミニオンを1体以上コントロールしているなら、' +
    '相手のダメージを1種のミニオンに優先的に割り振る。割り振られる種類はあなたが選択する。＞',
  effect: {
    t: 'grantContinuous',
    duration: 'whileOnStack',
    mod: {
      t: 'damageRedirect',
      who: { t: 'self' },
      to: { t: 'minion', species: { t: 'choose', chooser: { t: 'self' }, onlyExisting: true }, owner: { t: 'self' } },
      overflow: 'carry',
    },
  },
};

/** 天候で効果が丸ごと変わる。modal ではなく天候による分岐なので if の入れ子で書く */
export const resonance: NamedActionDef = {
  id: 'sky/resonance',
  name: 'レゾナンス',
  god: 'sky',
  text:
    '天候が晴・炎天なら、このサイクルあなたのダメージは軽減されず、対象に5点のダメージを与える。\n' +
    '天候が雨・豪雨なら、あなたはライフを5回復し、カードを2枚引く。\n' +
    '天候が吹雪・雷雲なら、このサイクルあなたのスタック上のカードは対象に取られず、あなたは回避4を得る。',
  effect: {
    t: 'if',
    cond: { t: 'weatherIs', weather: ['clear', 'blaze'] },
    then: {
      t: 'seq',
      of: [
        {
          t: 'grantContinuous',
          duration: 'thisCycle',
          mod: { t: 'damageFlagGrant', who: { t: 'self' }, flags: { unreducible: true } },
        },
        { t: 'damage', to: { t: 'target' }, amount: 5 },
      ],
    },
    else: {
      t: 'if',
      cond: { t: 'weatherIs', weather: ['rain', 'downpour'] },
      then: {
        t: 'seq',
        of: [
          { t: 'heal', to: { t: 'self' }, amount: 5 },
          { t: 'draw', player: { t: 'self' }, count: 2 },
        ],
      },
      else: {
        t: 'seq',
        of: [
          {
            t: 'grantContinuous',
            duration: 'thisCycle',
            mod: { t: 'untargetable', items: { t: 'all', filter: { controller: { t: 'self' } } } },
          },
          { t: 'gainStatus', player: { t: 'self' }, kind: 'evasion', amount: 4, duration: 'thisCycle' },
        ],
      },
    },
  },
};

// ============================================================
// トークン（大地の装備品）
// ============================================================

export const infernoFury: TokenDef = {
  id: 'earth/sword',
  name: 'インフェルノフューリー（剣）',
  god: 'earth',
  kind: 'weapon',
  maxCopies: 3,
  text: 'あなたの与える斬撃のダメージは＋1される。',
  abilities: [
    {
      kind: 'continuous',
      active: 'inField',
      mod: { t: 'damageDelta', amount: 1, who: { t: 'self' }, direction: 'dealt', tags: ['slash'] },
    },
  ],
};

export const vermilionPierce: TokenDef = {
  id: 'earth/spear',
  name: 'ヴァーミリオンピアス（槍）',
  god: 'earth',
  kind: 'weapon',
  maxCopies: 3,
  text: 'あなたが刺突を行うなら、それは軽減されない。このカードが生成されたとき刺突を行う。',
  abilities: [
    {
      kind: 'continuous',
      active: 'inField',
      mod: { t: 'damageFlagGrant', who: { t: 'self' }, tags: ['thrust'], flags: { unreducible: true } },
    },
    {
      kind: 'triggered',
      active: 'inField',
      when: { on: 'tokenCreated' },
      effect: { t: 'performAction', action: 'earth/thrust' },
    },
  ],
};

export const grandDestruction: TokenDef = {
  id: 'earth/hammer',
  name: 'グランドデストラクション（槌）',
  god: 'earth',
  kind: 'relic',
  unique: true,
  text:
    'グランドデストラクションは神器である。これは1つしか装備できない。\n' +
    'あなたの打撃のダメージは＋3される。あなたが打撃を行うなら、それは回避できない。',
  abilities: [
    {
      kind: 'continuous',
      active: 'inField',
      mod: { t: 'damageDelta', amount: 3, who: { t: 'self' }, direction: 'dealt', tags: ['strike'] },
    },
    {
      kind: 'continuous',
      active: 'inField',
      mod: { t: 'damageFlagGrant', who: { t: 'self' }, tags: ['strike'], flags: { unavoidable: true } },
    },
  ],
};

export const obsidianGuard: TokenDef = {
  id: 'earth/armor_obsidian',
  name: '黒曜備え',
  god: 'earth',
  kind: 'armor',
  maxCopies: 3,
  text: 'これを装備している数に等しいダメージを軽減する。',
  abilities: [
    {
      kind: 'continuous',
      active: 'inField',
      mod: {
        t: 'damageReduction',
        who: { t: 'self' },
        amount: { t: 'countTokens', filter: { name: '黒曜備え', owner: { t: 'self' } } },
      },
    },
  ],
};


export const scorchingMantle: TokenDef = {
  id: 'earth/armor_mantle',
  name: '灼熱の外套',
  god: 'earth',
  kind: 'armor',
  unique: true,
  text:
    'これは1つしか装備できない。\n' +
    '炎天によるダメージを受けなくなる。\n' +
    '1サイクルに2回まで、相手のカードか効果からダメージを受けたら相手に獄焔を1付与する。',
  abilities: [
    {
      kind: 'continuous',
      active: 'inField',
      mod: { t: 'weatherImmune', who: { t: 'self' }, weather: 'blaze' },
    },
    {
      kind: 'triggered',
      active: 'inField',
      limit: { count: 2, per: 'cycle' },
      when: { on: 'damageTaken', filter: { controller: { t: 'opponent' } } },
      effect: { t: 'addPlayerCounter', kind: 'infernalFlame', to: { t: 'opponent' }, amount: 1 },
    },
  ],
};

// ============================================================
// ミニオン（生命）
// ============================================================

export const minions: MinionDef[] = [
  {
    species: 'human',
    name: '人間',
    text: 'ターン経過ごとに2倍に増える。',
    abilities: [
      {
        kind: 'triggered',
        active: 'inField',
        when: { on: 'cycleStart' },
        effect: {
          t: 'createMinion',
          species: 'human',
          count: { t: 'countMinions', species: 'human', of: { t: 'self' } },
        },
      },
    ],
  },
  {
    species: 'angel',
    name: '天使',
    text: '超過ダメージをすべて軽減する。',
    abilities: [
      {
        kind: 'continuous',
        active: 'inField',
        mod: { t: 'damageRedirect', who: { t: 'self' }, to: { t: 'minion', species: 'angel', owner: { t: 'self' } }, overflow: 'absorb' },
      },
    ],
  },
  {
    species: 'wraith',
    name: '死霊',
    text: '減った数をxとして相手にxダメージ。ダメージボーナスは乗らず、軽減できない。',
    abilities: [
      {
        kind: 'triggered',
        active: 'inField',
        // 暗黙束縛 count = 死亡した体数（granularity 既定 perEvent なので1回だけ発火する）
        when: { on: 'minionDied' },
        effect: {
          t: 'damage',
          to: { t: 'player', who: { t: 'opponent' } },
          amount: { t: 'var', name: 'count' },
          flags: { ignoreCycleBonus: true, unreducible: true },
        },
      },
    ],
  },
  {
    species: 'beast',
    name: '魔獣',
    text: '攻撃に使われるとき1体につきダメージボーナスが乗る。',
    abilities: [
      {
        kind: 'continuous',
        active: 'inField',
        mod: {
          t: 'damageDelta',
          who: { t: 'self' },
          direction: 'dealt',
          tags: ['attackOrder'],
          amount: { t: 'countMinions', species: 'beast', of: { t: 'self' } },
        },
      },
    ],
  },
];

// ============================================================
// 海の神
// ============================================================

export const futureChoice: CardDef = {
  id: 'sea/future_choice',
  name: '未来の選択',
  god: 'sea',
  types: ['ドロー'],
  text:
    'あなたのデッキを一つ選び、カードを3枚探す。そのデッキをシャッフルする。\n' +
    'その内、1枚を手札に加え、1枚を墓地に置き、1枚をデッキの下に置く。',
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'let',
        name: 'pile',
        select: { of: 'number', value: { t: 'chooseNumber', chooser: { t: 'self' }, min: 0 } },
        then: {
          t: 'seq',
          of: [
            // 探した3枚を一時領域(staging)に置く
            {
              t: 'moveCards',
              to: { zone: 'staging', owner: { t: 'self' } },
              cards: {
                t: 'choose',
                count: 3,
                chooser: { t: 'self' },
                from: { zone: 'deck', owner: { t: 'self' }, pile: { t: 'var', name: 'pile' } },
              },
            },
            { t: 'shuffle', of: { zone: 'deck', owner: { t: 'self' }, pile: { t: 'var', name: 'pile' } } },
            // staging から1枚ずつ振り分ける
            {
              t: 'moveCards',
              cards: { t: 'choose', count: 1, chooser: { t: 'self' }, from: { zone: 'staging', owner: { t: 'self' } } },
              to: { zone: 'hand', owner: { t: 'self' } },
            },
            {
              t: 'moveCards',
              cards: { t: 'choose', count: 1, chooser: { t: 'self' }, from: { zone: 'staging', owner: { t: 'self' } } },
              to: { zone: 'graveyard', owner: { t: 'self' } },
            },
            {
              t: 'moveCards',
              cards: { t: 'all', from: { zone: 'staging', owner: { t: 'self' } } },
              to: { zone: 'deck', owner: { t: 'self' }, pile: { t: 'var', name: 'pile' } },
              position: 'bottom',
            },
          ],
        },
      },
    },
  ],
  note: '宿題1: 一時領域 staging の使用例。staging は効果の解決終了時に空でなければならない（不変条件テストで担保）。',
};

export const floodingWisdom: CardDef = {
  id: 'sea/flooding_wisdom',
  name: '氾濫する知恵',
  god: 'sea',
  types: ['ドロー'],
  text:
    'カードを1枚引く。\n' +
    'このゲーム中、あなたがこれ以降カード効果によってカードを引く際、常にその枚数に1を加えた枚数のカードを引く。',
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          { t: 'draw', player: { t: 'self' }, count: 1 },
          {
            t: 'grantContinuous',
            duration: 'thisGame',
            mod: { t: 'drawDelta', amount: 1, who: { t: 'self' }, onlyFromCardEffect: true },
          },
        ],
      },
    },
  ],
};

export const reactiveAquaSphere: CardDef = {
  id: 'sea/reactive_aqua_sphere',
  name: 'リアクティブアクアスフィア',
  god: 'sea',
  types: ['ドロー', '攻撃', '戦術'],
  text:
    '常在＜このカードの上に相手がカードを乗せた時、相手に3ダメージを与える。＞\n' +
    'このカードが相手にダメージを与えていたなら、カードを1枚引く。',
  keywords: ['static'],
  abilities: [
    {
      kind: 'triggered',
      active: 'onStack',
      when: {
        on: 'placedOnStack',
        filter: { controller: { t: 'opponent' }, is: { t: 'above', of: { t: 'this' } } },
      },
      effect: { t: 'damage', to: { t: 'player', who: { t: 'opponent' } }, amount: 3 },
    },
    {
      kind: 'onResolve',
      effect: {
        t: 'if',
        cond: {
          t: 'cmp',
          a: {
            t: 'countEvent',
            event: 'damageDealt',
            scope: 'cycle',
            measure: 'units',
            source: { t: 'this' },
          },
          op: '>=',
          b: 1,
        },
        then: { t: 'draw', player: { t: 'self' }, count: 1 },
      },
    },
  ],
  note: '宿題2: countEvent.source で「このカードが与えたダメージ」を発生源単位で数える。常在の誘発で飛んだ3点もこのカードが発生源なので正しく拾える。',
};

export const accumulatingWater: CardDef = {
  id: 'sea/accumulating_water',
  name: '蓄積の魔水',
  god: 'sea',
  types: ['ドロー', '戦術'],
  text:
    'スタック上のカード1枚を対象とする。その上に詠唱カウンターがあるなら、それを2増やす。\n' +
    'カードを1枚引く。',
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          {
            t: 'addCounter',
            kind: 'chant',
            amount: 2,
            on: { t: 'choose', count: 1, chooser: { t: 'self' }, filter: { kind: 'card', hasCounter: 'chant' } },
          },
          { t: 'draw', player: { t: 'self' }, count: 1 },
        ],
      },
    },
  ],
};

export const domainExpansion: CardDef = {
  id: 'sea/domain_expansion',
  name: 'ドメインエキスパンション',
  god: 'sea',
  types: ['ドロー', '特殊勝利'],
  text:
    '詠唱\n' +
    'このカードの詠唱カウンターが5以上なら、カードを2枚引く。\n' +
    '8以上なら、ライフを10回復する。\n' +
    '15以上なら、勝利する。\n' +
    'このカードはスタック上で位置を変えることができない。',
  keywords: ['chant'],
  immovable: true,
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          {
            t: 'if',
            cond: { t: 'cmp', a: { t: 'counters', kind: 'chant', on: { t: 'this' } }, op: '>=', b: 5 },
            then: { t: 'draw', player: { t: 'self' }, count: 2 },
          },
          {
            t: 'if',
            cond: { t: 'cmp', a: { t: 'counters', kind: 'chant', on: { t: 'this' } }, op: '>=', b: 8 },
            then: { t: 'heal', to: { t: 'self' }, amount: 10 },
          },
          {
            t: 'if',
            cond: { t: 'cmp', a: { t: 'counters', kind: 'chant', on: { t: 'this' } }, op: '>=', b: 15 },
            then: { t: 'win', player: { t: 'self' } },
          },
        ],
      },
    },
  ],
};

export const dreadfulTidalWave: CardDef = {
  id: 'sea/dreadful_tidal_wave',
  name: 'ドレッドフル・タイダルウェイブ',
  god: 'sea',
  types: ['攻撃', '奥義'],
  text:
    '詠唱\n' +
    '常在＜詠唱が3になったら相手に2点、6になったら相手に5点、9になったら相手に軽減不可の13点のダメージを与える。＞\n' +
    'このカードは1サイクルに1枚しかプレイできない。',
  keywords: ['chant', 'static'],
  play: { limit: { count: 1, per: 'cycle' } },
  abilities: [
    {
      kind: 'thresholds',
      active: 'onStack',
      counter: 'chant',
      steps: [
        { at: 3, effect: { t: 'damage', to: { t: 'player', who: { t: 'opponent' } }, amount: 2 } },
        { at: 6, effect: { t: 'damage', to: { t: 'player', who: { t: 'opponent' } }, amount: 5 } },
        {
          at: 9,
          effect: {
            t: 'damage',
            to: { t: 'player', who: { t: 'opponent' } },
            amount: 13,
            flags: { unreducible: true },
          },
        },
      ],
    },
  ],
  note: 'thresholds 糖衣の使用例。triggered（counterChanged + cmp \'==\'）を3つ並べたものと等価だが、閾値と効果の対応が一望できる。',
};

export const abyssCascade: CardDef = {
  id: 'sea/abyss_cascade',
  name: 'アビスカスケード',
  god: 'sea',
  types: ['攻撃', '魔術', '水'],
  text: '瞬発\n相手かミニオンを選び4点のダメージを与える。\nスタック上の自分のカードを1枚選び、スタックの一番上に置く。',
  keywords: ['instant'],
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          { t: 'damage', to: { t: 'chooseEntity', among: ['opponent', 'minion'] }, amount: 4 },
          {
            t: 'moveStackItem',
            to: 'top',
            by: { t: 'self' },
            item: { t: 'choose', count: 1, chooser: { t: 'self' }, filter: { controller: { t: 'self' } } },
          },
        ],
      },
    },
  ],
};

export const amplifiableShield: CardDef = {
  id: 'sea/amplifiable_shield',
  name: 'アンプリファイバブルシールド',
  god: 'sea',
  types: ['防御'],
  text:
    '詠唱\n' +
    'このカードは1サイクルに1枚しかプレイできない。\n' +
    'このカードをプレイしたとき詠唱カウンターをこのカードの上にさらに5つ置く。\n' +
    '常在＜あなたは詠唱カウンターに等しいダメージを軽減する。ダメージを軽減する度、詠唱カウンターをダメージ分取り除く。\n' +
    'このカードの詠唱カウンターが0以下になるなら、スタックから取り除き墓地に置く。＞',
  keywords: ['chant', 'static'],
  play: { limit: { count: 1, per: 'cycle' } },
  abilities: [
    { kind: 'onPlay', effect: { t: 'addCounter', kind: 'chant', on: { t: 'this' }, amount: 5 } },
    {
      kind: 'continuous',
      active: 'onStack',
      mod: {
        t: 'damageReduction',
        who: { t: 'self' },
        amount: { t: 'counters', kind: 'chant', on: { t: 'this' } },
        onApply: { t: 'removeCounter', kind: 'chant', on: { t: 'this' }, amount: { t: 'var', name: 'reduced' } },
      },
    },
    {
      kind: 'triggered',
      active: 'onStack',
      when: {
        on: 'counterChanged',
        subject: { t: 'this' },
        cond: { t: 'cmp', a: { t: 'counters', kind: 'chant', on: { t: 'this' } }, op: '<=', b: 0 },
      },
      effect: { t: 'moveStackToZone', item: { t: 'this' }, to: { zone: 'graveyard', owner: { t: 'self' } } },
    },
  ],
  note: 'onApply の中で「軽減した量」を参照するため、置換効果の実行時に reduced を暗黙束縛する規約を置いている（設計書 §5）。',
};

export const knownPeril: CardDef = {
  id: 'sea/known_peril',
  name: '既知の危機',
  god: 'sea',
  types: ['防御'],
  text:
    '常在＜スタックフェイズ中、相手がカードをスタックに乗せたとき、\n' +
    '「スタックからカードか効果を1つ選ぶ。瞬発を持つカードを選ぶなら、あなたはカードを1枚手札から捨てなければならない。\n' +
    '墓地から3枚のカードを除外し、選んだカードか効果を墓地に置く。このカードを除外する」を行ってもよい。＞',
  keywords: ['static'],
  abilities: [
    {
      kind: 'triggered',
      active: 'onStack',
      optional: true,
      when: { on: 'placedOnStack', filter: { controller: { t: 'opponent' }, kind: 'card' } },
      effect: {
        t: 'let',
        name: 'chosen',
        select: { of: 'stack', sel: { t: 'choose', count: 1, chooser: { t: 'self' }, filter: { kind: ['card', 'effect'] } } },
        then: {
          t: 'seq',
          of: [
            // 選んだものが瞬発なら、事後にコストが発生する
            {
              t: 'if',
              cond: { t: 'matchesStack', item: { t: 'var', name: 'chosen' }, filter: { hasKeyword: 'instant' } },
              then: { t: 'discard', player: { t: 'self' }, count: 1 },
            },
            {
              t: 'moveCards',
              cards: { t: 'choose', count: 3, chooser: { t: 'self' }, from: { zone: 'graveyard', owner: { t: 'self' } } },
              to: { zone: 'exile', owner: { t: 'self' } },
            },
            {
              t: 'moveStackToZone',
              item: { t: 'var', name: 'chosen' },
              to: { zone: 'graveyard', owner: { t: 'self' } },
            },
            { t: 'moveStackToZone', item: { t: 'this' }, to: { zone: 'exile', owner: { t: 'self' } } },
          ],
        },
      },
    },
  ],
  note: '宿題3: let で選択結果を先に束縛し、matchesStack で「瞬発を選ぶなら」の事後コストを課す。cost（事前払い）では書けなかった形。',
};

export const flowingWaterDance: CardDef = {
  id: 'sea/flowing_water_dance',
  name: '流水円舞',
  god: 'sea',
  types: ['防御', '回避'],
  text: '瞬発\n手札からカードをx枚捨てる。あなたはこのサイクルxの回避を得る。',
  keywords: ['instant'],
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'bind',
        name: 'x',
        of: {
          t: 'discard',
          player: { t: 'self' },
          count: {
            t: 'chooseNumber',
            chooser: { t: 'self' },
            min: 0,
            max: { t: 'countZone', of: { zone: 'hand', owner: { t: 'self' } } },
          },
        },
        then: {
          t: 'gainStatus',
          player: { t: 'self' },
          kind: 'evasion',
          amount: { t: 'var', name: 'x' },
          duration: 'thisCycle',
        },
      },
    },
  ],
};

export const embraceOfTheSea: CardDef = {
  id: 'sea/embrace',
  name: '海の抱擁',
  god: 'sea',
  types: ['特殊勝利'],
  text:
    'このカードはあなたのサイクルの初めにプレイするカードでなければならない。\n' +
    'あなたがこのカードをスタックに乗せたとき、あなたのライフを記録する。\n' +
    'あなたのライフが記録したライフと同じだったなら、勝利する。\n' +
    'このカードはスタック上で位置を変えることができない。',
  immovable: true,
  play: { mustBeFirstOfCycle: true },
  abilities: [
    {
      kind: 'onPlay',
      effect: { t: 'snapshot', name: 'embraceLife', value: { t: 'life', of: { t: 'self' } } },
    },
    {
      kind: 'onResolve',
      effect: {
        t: 'if',
        cond: {
          t: 'cmp',
          a: { t: 'life', of: { t: 'self' } },
          op: '==',
          b: { t: 'snapshotValue', name: 'embraceLife' },
        },
        then: { t: 'win', player: { t: 'self' } },
      },
    },
  ],
};

export const splitDimension: CardDef = {
  id: 'sea/split_dimension',
  name: 'スプリットディメンション',
  god: 'sea',
  types: ['戦術', '擬似追加ターン'],
  text:
    '詠唱\n' +
    '常在＜詠唱カウンターが2になったとき、このカードの効果を解決する。＞\n' +
    '現在のスタックにあるカードを上から順に全て解決する。（サイクルは終了しない）\n' +
    'このカードは1サイクルに1枚しかプレイできない。',
  keywords: ['chant', 'static'],
  play: { limit: { count: 1, per: 'cycle' } },
  abilities: [
    {
      kind: 'triggered',
      active: 'onStack',
      when: {
        on: 'counterChanged',
        subject: { t: 'this' },
        cond: { t: 'cmp', a: { t: 'counters', kind: 'chant', on: { t: 'this' } }, op: '==', b: 2 },
      },
      effect: { t: 'resolveStack', items: { t: 'all' } },
    },
    { kind: 'onResolve', effect: { t: 'resolveStack', items: { t: 'all' } } },
  ],
};

export const wisdomVault: CardDef = {
  id: 'sea/wisdom_vault',
  name: '叡智保管庫',
  god: 'sea',
  types: ['戦術', '永続', '回復'],
  text: 'このゲーム中、あなたは手札を何枚でも持ち越せる。\nあなたの手札枚数と同じ数ライフを回復する。',
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          {
            t: 'grantContinuous',
            duration: 'thisGame',
            mod: { t: 'handLimit', amount: 'none', who: { t: 'self' } },
          },
          { t: 'heal', to: { t: 'self' }, amount: { t: 'countZone', of: { zone: 'hand', owner: { t: 'self' } } } },
        ],
      },
    },
  ],
};

export const melancholicRain: CardDef = {
  id: 'sea/melancholic_rain',
  name: 'メランコリックレイン',
  god: 'sea',
  types: ['戦術', '天候'],
  text:
    '詠唱\n' +
    '天候が豪雨でないなら雨に変更する。すでに雨であるなら、豪雨にしてもよい。\n' +
    'その後、詠唱カウンターが4以上なら、あなたはこのサイクル中\n' +
    '「相手のカードによって天候が変化するなら、それを打ち消す。この能力を消滅させる。」を得る。\n' +
    'すでにこの能力を持っていたなら、それは獲得されない。',
  keywords: ['chant'],
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          { t: 'setWeather', weather: 'rain', ifAlreadyThen: 'downpour' },
          {
            t: 'if',
            cond: { t: 'cmp', a: { t: 'counters', kind: 'chant', on: { t: 'this' } }, op: '>=', b: 4 },
            then: {
              t: 'grantContinuous',
              duration: 'thisCycle',
              onceOnly: true,
              mod: { t: 'preventWeatherChange', by: { t: 'opponent' }, times: 1 },
            },
          },
        ],
      },
    },
  ],
};

export const parallelThinking: CardDef = {
  id: 'sea/parallel_thinking',
  name: '並列思考',
  god: 'sea',
  types: ['戦術'],
  text:
    'あなたのデッキを一つ選びシャッフルする。その後シャッフルしたデッキを2等分し、それぞれの一番上のカード1枚を見てもよい。\n' +
    'このゲーム中、あなたはカードを引く際、任意のあなたのデッキを選べる。',
  abilities: [
    { kind: 'onResolve', effect: { t: 'handler', id: 'sea/splitDeck', params: { parts: 2, peek: true } } },
  ],
  note: 'handler に逃がす基準 ①ゲームの基礎構造を変える。splitDeck 効果自体は DSL にもあるが、「以降のドロー時にデッキを選べる」状態の管理はエンジン側。',
};


export const flashOfInsight: CardDef = {
  id: 'sea/flash_of_insight',
  name: '閃きの再来',
  god: 'sea',
  types: ['ドロー'],
  text: '墓地からカードを2枚手札に加えてもよい。\nこのカードを除外する。',
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          {
            t: 'optional',
            chooser: { t: 'self' },
            body: {
              t: 'moveCards',
              to: { zone: 'hand', owner: { t: 'self' } },
              cards: {
                t: 'choose',
                count: 2,
                upTo: true,
                chooser: { t: 'self' },
                from: { zone: 'graveyard', owner: { t: 'self' } },
              },
            },
          },
          { t: 'moveStackToZone', item: { t: 'this' }, to: { zone: 'exile', owner: { t: 'self' } } },
        ],
      },
    },
  ],
};

export const questForUnknown: CardDef = {
  id: 'sea/quest_for_unknown',
  name: '未知の探求',
  god: 'sea',
  types: ['ドロー', '戦術'],
  text:
    '自分のデッキを1つ選び、上から3枚確認する。その中から1枚を手札に加え、\n' +
    '残ったカードを任意の順番で山札の下に置く。\nカードを1枚引く。',
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'let',
        name: 'pile',
        select: { of: 'number', value: { t: 'chooseNumber', chooser: { t: 'self' }, min: 0 } },
        then: {
          t: 'seq',
          of: [
            {
              t: 'moveCards',
              to: { zone: 'staging', owner: { t: 'self' } },
              cards: { t: 'top', count: 3, from: { zone: 'deck', owner: { t: 'self' }, pile: { t: 'var', name: 'pile' } } },
            },
            {
              t: 'moveCards',
              cards: { t: 'choose', count: 1, chooser: { t: 'self' }, from: { zone: 'staging', owner: { t: 'self' } } },
              to: { zone: 'hand', owner: { t: 'self' } },
            },
            {
              t: 'moveCards',
              cards: { t: 'all', from: { zone: 'staging', owner: { t: 'self' } } },
              to: { zone: 'deck', owner: { t: 'self' }, pile: { t: 'var', name: 'pile' } },
              position: 'bottom',
              order: 'choose',
            },
            { t: 'draw', player: { t: 'self' }, count: 1 },
          ],
        },
      },
    },
  ],
};

export const terribleVortex: CardDef = {
  id: 'sea/terrible_vortex',
  name: 'テリブルボルテックス',
  god: 'sea',
  types: ['攻撃', '魔術', '水'],
  text:
    '相手かミニオンを選び5点のダメージを与える。\n' +
    'ダメージを与えたならば、自分のカードを1枚選び、任意の位置に置く。',
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'bind',
        name: 'dealt',
        of: { t: 'damage', to: { t: 'chooseEntity', among: ['opponent', 'minion'] }, amount: 5 },
        then: {
          t: 'if',
          cond: { t: 'cmp', a: { t: 'var', name: 'dealt' }, op: '>=', b: 1 },
          then: {
            t: 'moveStackItem',
            to: 'anywhere',
            by: { t: 'self' },
            item: { t: 'choose', count: 1, chooser: { t: 'self' }, filter: { controller: { t: 'self' } } },
          },
        },
      },
    },
  ],
};

export const currentControl: CardDef = {
  id: 'sea/current_control',
  name: '水流操作',
  god: 'sea',
  types: ['戦術', '並び替え'],
  text:
    '瞬発\n' +
    'このサイクル中、相手の手札は公開される。\n' +
    'スタックからカードか効果を1枚選び、スタックの任意の位置に置く。',
  keywords: ['instant'],
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          {
            t: 'grantContinuous',
            duration: 'thisCycle',
            mod: { t: 'revealHand', who: { t: 'opponent' } },
          },
          {
            t: 'moveStackItem',
            to: 'anywhere',
            by: { t: 'self' },
            item: { t: 'choose', count: 1, chooser: { t: 'self' }, filter: { kind: ['card', 'effect'] } },
          },
        ],
      },
    },
  ],
};

export const wisdomOfWater: CardDef = {
  id: 'sea/wisdom_of_water',
  name: '潤水の智慧',
  god: 'sea',
  types: ['天候'],
  text:
    '常在＜天候が豪雨ならば相手の手札は公開される＞\n' +
    '天候が豪雨でないなら雨にする。すでに雨であるなら、豪雨にしてもよい。\n' +
    'あなたはこのゲーム中、豪雨の効果を受けなくなる。',
  keywords: ['static'],
  abilities: [
    {
      kind: 'continuous',
      active: 'onStack',
      cond: { t: 'weatherIs', weather: 'downpour' },
      mod: { t: 'revealHand', who: { t: 'opponent' } },
    },
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          {
            t: 'if',
            cond: { t: 'not', of: { t: 'weatherIs', weather: 'downpour' } },
            then: { t: 'setWeather', weather: 'rain', ifAlreadyThen: 'downpour' },
          },
          {
            t: 'grantContinuous',
            duration: 'thisGame',
            mod: { t: 'weatherImmune', who: { t: 'self' }, weather: 'downpour' },
          },
        ],
      },
    },
  ],
  note: '「豪雨の効果を受けなくなる」= プレイ時の1枚捨てを無視する、という意味（設定シート注記）。weatherImmune がそれを表す。',
};

export const waterIllusion: CardDef = {
  id: 'sea/water_illusion',
  name: 'ウォーターイリュージョン',
  god: 'sea',
  types: ['防御', '擬似回復'],
  text: 'このカードをスタックに乗せたとき、あなたのライフを20回復する。\nあなたはライフを20失う。',
  abilities: [
    { kind: 'onPlay', effect: { t: 'heal', to: { t: 'self' }, amount: 20 } },
    { kind: 'onResolve', effect: { t: 'loseLife', to: { t: 'self' }, amount: 20 } },
  ],
  note: 'プレイ時に一時ライフを得て解決時に失う。onPlay と onResolve の時間差そのものがカードの効果になっている例。',
};

export const requiem: CardDef = {
  id: 'sea/requiem',
  name: '鎮魂歌',
  god: 'sea',
  types: ['防御', '天候'],
  text:
    '常在＜天候が雨or豪雨であるならすべてのダメージを1軽減する＞\n' +
    '天候が豪雨でないなら雨に変更する。\n' +
    '墓地から3枚までデッキに戻しシャッフルする。',
  keywords: ['static'],
  abilities: [
    {
      kind: 'continuous',
      active: 'onStack',
      cond: { t: 'weatherIs', weather: ['rain', 'downpour'] },
      mod: { t: 'damageReduction', amount: 1, who: { t: 'self' } },
    },
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          {
            t: 'if',
            cond: { t: 'not', of: { t: 'weatherIs', weather: 'downpour' } },
            then: { t: 'setWeather', weather: 'rain' },
          },
          {
            t: 'moveCards',
            to: { zone: 'deck', owner: { t: 'self' } },
            cards: {
              t: 'choose',
              count: 3,
              upTo: true,
              chooser: { t: 'self' },
              from: { zone: 'graveyard', owner: { t: 'self' } },
            },
          },
          { t: 'shuffle', of: { zone: 'deck', owner: { t: 'self' } } },
        ],
      },
    },
  ],
};

// ============================================================
// 大地の神
// ============================================================

export const combination: CardDef = {
  id: 'earth/combination',
  name: 'コンビネーション',
  god: 'earth',
  types: ['攻撃', '物理', '近接'],
  text: '戦技を2回行う。同じものは2回選べない。',
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'performAction',
        times: 2,
        distinct: true,
        action: { t: 'chooseFrom', group: 'earth/combatArt', chooser: { t: 'self' } },
      },
    },
  ],
};

export const crushingBlow: CardDef = {
  id: 'earth/crushing_blow',
  name: '鎧袖一触',
  god: 'earth',
  types: ['攻撃', '物理', '近接'],
  text:
    '相手かミニオンを選び3＋xダメージを与える。xは武器の装備数である。\n' +
    'このサイクルに受けるダメージを、このカードが解決されたときに装備していた防具数だけ軽減する。',
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          {
            t: 'damage',
            to: { t: 'chooseEntity', among: ['opponent', 'minion'] },
            amount: { t: 'add', a: 3, b: { t: 'countTokens', filter: { kind: 'weapon', owner: { t: 'self' } } } },
          },
          {
            t: 'gainStatus',
            player: { t: 'self' },
            kind: 'reduction',
            duration: 'thisCycle',
            amount: { t: 'countTokens', filter: { kind: 'armor', owner: { t: 'self' } } },
          },
        ],
      },
    },
  ],
};

export const crimsonIgnition: CardDef = {
  id: 'earth/crimson_ignition',
  name: '紅蓮着火',
  god: 'earth',
  types: ['攻撃', '炎'],
  text: '相手に3点のダメージを与える。\nこれによって相手に与えたダメージに等しい獄焔を付与する。',
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'bind',
        name: 'dealt',
        of: { t: 'damage', to: { t: 'player', who: { t: 'opponent' } }, amount: 3, tags: ['fire'] },
        then: {
          t: 'addPlayerCounter',
          kind: 'infernalFlame',
          to: { t: 'opponent' },
          amount: { t: 'var', name: 'dealt' },
        },
      },
    },
  ],
};

export const indestructibleWall: CardDef = {
  id: 'earth/indestructible_wall',
  name: '不壊剛壁',
  god: 'earth',
  types: ['防御'],
  text: '常在＜あなたは自傷ダメージを受けない。＞',
  keywords: ['static'],
  abilities: [
    {
      kind: 'continuous',
      active: 'onStack',
      mod: { t: 'damagePrevention', who: { t: 'self' }, tags: ['self'] },
    },
  ],
};

export const gutsCard: CardDef = {
  id: 'earth/guts',
  name: '根性',
  god: 'earth',
  types: ['防御'],
  text: '常在＜あなたのライフが0以下になるなら、このカードを除外して、代わりにライフを1にする。＞',
  keywords: ['static'],
  abilities: [
    {
      kind: 'continuous',
      active: 'onStack',
      mod: {
        t: 'lethalReplacement',
        who: { t: 'self' },
        setLifeTo: 1,
        then: { t: 'moveStackToZone', item: { t: 'this' }, to: { zone: 'exile', owner: { t: 'self' } } },
      },
    },
  ],
};

export const instantForge: CardDef = {
  id: 'earth/instant_forge',
  name: 'インスタントフォージ',
  god: 'earth',
  types: ['戦術', '鍛造'],
  text:
    '瞬発\n' +
    '神器でない武器か防具いずれか1つ生成し、装備する。\n' +
    'その後、まだ装備しておらず神器でない武器いずれか1つを生成し、装備する。\n' +
    'そのサイクル終了時、このカードによって生成した武器もしくは防具1つを墓地に置く。',
  keywords: ['instant'],
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          {
            t: 'createToken',
            equip: true,
            mark: 'instantForge',
            token: { t: 'choose', kind: ['weapon', 'armor'], chooser: { t: 'self' }, excludeRelic: true },
          },
          {
            t: 'createToken',
            equip: true,
            mark: 'instantForge',
            token: { t: 'choose', kind: 'weapon', chooser: { t: 'self' }, excludeRelic: true, excludeEquipped: true },
          },
          {
            t: 'grantTrigger',
            duration: 'thisCycle',
            trigger: {
              when: { on: 'turnEnd' },
              effect: {
                t: 'destroyToken',
                tokens: { t: 'choose', count: 1, chooser: { t: 'self' }, filter: { mark: 'instantForge' } },
                to: { zone: 'graveyard', owner: { t: 'self' } },
              },
            },
          },
        ],
      },
    },
  ],
  note: '宿題4: createToken.mark で出自を刻み、TokenFilter.mark で「このカードによって生成した」を絞る。',
};

export const scarletAnnihilation: CardDef = {
  id: 'earth/scarlet_annihilation',
  name: '緋焔滅尽',
  god: 'earth',
  types: ['特殊勝利', '戦術'],
  text:
    '手札からカードを1枚捨てることでこのカードをプレイできる。\n' +
    '相手に獄焔を4付与する。\n' +
    'その後、獄焔が15以上であったなら、あなたは勝利する。',
  play: { cost: { t: 'discard', player: { t: 'self' }, count: 1 } },
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          { t: 'addPlayerCounter', kind: 'infernalFlame', to: { t: 'opponent' }, amount: 4 },
          {
            t: 'if',
            cond: {
              t: 'cmp',
              a: { t: 'playerCounter', kind: 'infernalFlame', of: { t: 'opponent' } },
              op: '>=',
              b: 15,
            },
            then: { t: 'win', player: { t: 'self' } },
          },
        ],
      },
    },
  ],
};

export const earthrageEruption: CardDef = {
  id: 'earth/earthrage_eruption',
  name: 'アースレイジ・イラプション',
  god: 'earth',
  types: ['攻撃', '炎', '奥義'],
  text:
    '瞬発\n' +
    'このカードはあなたのライフが対戦相手よりも少なく、手札が2枚以下のときプレイできる。\n' +
    'このカードは1サイクルに1枚しかプレイできない。\n' +
    '「相手に5点のダメージを与え、相手にダメージを与えたなら獄焔を1付与する。」を3回スタックに乗せる。',
  keywords: ['instant'],
  play: {
    limit: { count: 1, per: 'cycle' },
    cond: {
      t: 'and',
      of: [
        { t: 'cmp', a: { t: 'life', of: { t: 'self' } }, op: '<', b: { t: 'life', of: { t: 'opponent' } } },
        { t: 'cmp', a: { t: 'countZone', of: { zone: 'hand', owner: { t: 'self' } } }, op: '<=', b: 2 },
      ],
    },
  },
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'addToStack',
        times: 3,
        position: 'top',
        payload: {
          t: 'effect',
          text: '相手に5点のダメージを与え、相手にダメージを与えたなら獄焔を1付与する。',
          effect: {
            t: 'bind',
            name: 'dealt',
            of: { t: 'damage', to: { t: 'player', who: { t: 'opponent' } }, amount: 5, tags: ['fire'] },
            then: {
              t: 'if',
              cond: { t: 'cmp', a: { t: 'var', name: 'dealt' }, op: '>=', b: 1 },
              then: { t: 'addPlayerCounter', kind: 'infernalFlame', to: { t: 'opponent' }, amount: 1 },
            },
          },
        },
      },
    },
  ],
};


export const boilingLey: CardDef = {
  id: 'earth/boiling_ley',
  name: '煮え滾る地脈',
  god: 'earth',
  types: ['ドロー'],
  text:
    'カードを2枚引き、手札から1枚捨てる。\n' +
    'その後、武器か防具を一つ選んで捨ててもよい。そうしたなら、カードを1枚引く。',
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          { t: 'draw', player: { t: 'self' }, count: 2 },
          { t: 'discard', player: { t: 'self' }, count: 1 },
          {
            t: 'optional',
            chooser: { t: 'self' },
            body: {
              t: 'seq',
              of: [
                {
                  t: 'destroyToken',
                  to: { zone: 'graveyard', owner: { t: 'self' } },
                  tokens: {
                    t: 'choose',
                    count: 1,
                    chooser: { t: 'self' },
                    filter: { kind: ['weapon', 'armor'], owner: { t: 'self' } },
                  },
                },
                { t: 'draw', player: { t: 'self' }, count: 1 },
              ],
            },
          },
        ],
      },
    },
  ],
};

export const blazingRush: CardDef = {
  id: 'earth/blazing_rush',
  name: 'ブレイジングラッシュ',
  god: 'earth',
  types: ['ドロー'],
  text:
    '瞬発\n' +
    'カードを2枚引き、公開する。\n' +
    'このサイクルが終わるまで、あなたはカードをプレイするたび、2点のダメージを受ける。\n' +
    'このサイクル終了時にカードがプレイされなかったなら、それらのカードを墓地に置く。',
  keywords: ['instant'],
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'bind',
        name: 'drawn',
        of: { t: 'draw', player: { t: 'self' }, count: 2 },
        then: {
          t: 'seq',
          of: [
            { t: 'reveal', cards: { t: 'var', name: 'drawn' } },
            // 「それらのカード」を後のサイクル終了時まで持ち越すため snapshot に退避
            { t: 'snapshot', name: 'rushCards', select: { of: 'card', sel: { t: 'var', name: 'drawn' } } },
            {
              t: 'grantTrigger',
              duration: 'thisCycle',
              trigger: {
                when: { on: 'played', filter: { controller: { t: 'self' } } },
                effect: {
                  t: 'damage',
                  to: { t: 'player', who: { t: 'self' } },
                  amount: 2,
                  tags: ['self'],
                },
              },
            },
            {
              t: 'grantTrigger',
              duration: 'thisCycle',
              trigger: {
                when: { on: 'turnEnd' },
                effect: {
                  t: 'moveCards',
                  to: { zone: 'graveyard', owner: { t: 'self' } },
                  // まだ手札に残っている＝プレイされなかったもの
                  cards: {
                    t: 'all',
                    from: { zone: 'hand', owner: { t: 'self' } },
                    filter: { is: { t: 'var', name: 'rushCards' } },
                  },
                },
              },
            },
          ],
        },
      },
    },
  ],
  note: 'CardFilter.is の使用例。「それらのカード」を追跡するために bind → snapshot で持ち越し、手札に残っているかで「プレイされなかった」を判定する。',
};

export const flameForce: CardDef = {
  id: 'earth/flame_force',
  name: 'フレイムフォース',
  god: 'earth',
  types: ['ドロー'],
  text:
    'このサイクル中3回まで、あなたが相手にダメージを与えたなら獄焔を1付与する。\n' +
    'あなたのライフが対戦相手より少ないなら、カードを1枚引く。',
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          {
            t: 'grantTrigger',
            duration: 'thisCycle',
            trigger: {
              limit: { count: 3, per: 'cycle' },
              when: { on: 'damageDealt', subject: { t: 'self' } },
              effect: { t: 'addPlayerCounter', kind: 'infernalFlame', to: { t: 'opponent' }, amount: 1 },
            },
          },
          {
            t: 'if',
            cond: { t: 'cmp', a: { t: 'life', of: { t: 'self' } }, op: '<', b: { t: 'life', of: { t: 'opponent' } } },
            then: { t: 'draw', player: { t: 'self' }, count: 1 },
          },
        ],
      },
    },
  ],
};

export const heavenScorchingFlame: CardDef = {
  id: 'earth/heaven_scorching_flame',
  name: '天焦灼火',
  god: 'earth',
  types: ['攻撃', '炎'],
  text:
    '相手かミニオンを選び5点のダメージを与える。このダメージは軽減されず、回避されない。\n' +
    '天候が【炎天】である場合に限り、ダメージボーナスが適用される。',
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'if',
        cond: { t: 'weatherIs', weather: 'blaze' },
        then: {
          t: 'damage',
          to: { t: 'chooseEntity', among: ['opponent', 'minion'] },
          amount: 5,
          tags: ['fire'],
          flags: { unreducible: true, unavoidable: true },
        },
        else: {
          t: 'damage',
          to: { t: 'chooseEntity', among: ['opponent', 'minion'] },
          amount: 5,
          tags: ['fire'],
          flags: { unreducible: true, unavoidable: true, ignoreCycleBonus: true },
        },
      },
    },
  ],
  note: '「炎天のときだけダメボが乗る」は if/else で同じ damage を2回書く形になる。flags に条件を持たせる案もあったが、この1枚のために DamageFlags を条件式にするのは割に合わないと判断した。',
};

export const rampageChain: CardDef = {
  id: 'earth/rampage_chain',
  name: 'ランページチェイン',
  god: 'earth',
  types: ['攻撃', '物理', '近接'],
  text:
    '戦技を1回行う。\n' +
    'それによって相手に合計4点以上のダメージを与えたなら、相手に3点のダメージを与える。',
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'bind',
        name: 'dealt',
        of: { t: 'performAction', action: { t: 'chooseFrom', group: 'earth/combatArt', chooser: { t: 'self' } } },
        then: {
          t: 'if',
          cond: { t: 'cmp', a: { t: 'var', name: 'dealt' }, op: '>=', b: 4 },
          then: { t: 'damage', to: { t: 'player', who: { t: 'opponent' } }, amount: 3 },
        },
      },
    },
  ],
  note: 'bind は performAction の結果（そのアクションが与えた合計ダメージ）も受け取れる。刺突の1点×2回も合計で数える。',
};

export const cruelCarnage: CardDef = {
  id: 'earth/cruel_carnage',
  name: 'クルーエルカーネイジ',
  god: 'earth',
  types: ['攻撃', '物理', '近接'],
  text:
    '瞬発\n' +
    'このサイクル中、手札からカードをプレイする代わりに、カードを1枚捨てることで戦技を1回スタックに乗せてもよい。\n' +
    'あなたがこのサイクル受けるダメージを+1する。',
  keywords: ['instant'],
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          {
            t: 'grantContinuous',
            duration: 'thisCycle',
            mod: {
              t: 'alternativePlay',
              who: { t: 'self' },
              cost: { t: 'discard', player: { t: 'self' }, count: 1 },
              play: { t: 'action', action: { t: 'chooseFrom', group: 'earth/combatArt', chooser: { t: 'self' } } },
            },
          },
          {
            t: 'grantContinuous',
            duration: 'thisCycle',
            mod: { t: 'damageDelta', amount: 1, who: { t: 'self' }, direction: 'taken' },
          },
        ],
      },
    },
  ],
  note: 'alternativePlay の使用例。「プレイする代わりに」はプレイ制約層の話なので、効果ではなく継続効果として与える。',
};

export const burningEarth: CardDef = {
  id: 'earth/burning_earth',
  name: '燃え盛る大地',
  god: 'earth',
  types: ['戦術', '炎'],
  text:
    '常在＜カードか効果を解決しようとする度、そのコントローラーは1点のダメージを受ける。\n' +
    'このダメージは軽減できない。ダメージボーナスは受けない。＞',
  keywords: ['static'],
  abilities: [
    {
      kind: 'triggered',
      active: 'onStack',
      when: { on: 'resolving' },
      effect: {
        t: 'damage',
        // 暗黙束縛 source = 解決しようとしているスタック項目
        to: { t: 'player', who: { t: 'controllerOf', of: { t: 'var', name: 'source' } } },
        amount: 1,
        tags: ['fire'],
        flags: { unreducible: true, ignoreCycleBonus: true },
      },
    },
  ],
  note: '暗黙束縛 source から controllerOf でコントローラーを引く例。「そのコントローラー」を書くのにこれが要る。',
};

export const declarationOfRuin: CardDef = {
  id: 'earth/declaration_of_ruin',
  name: '破壊宣告',
  god: 'earth',
  types: ['戦術', '鍛造'],
  text: 'あなたに5点のダメージを与え、神器を生成し、装備する。\nこのダメージは軽減できず、回避できない。',
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          {
            t: 'damage',
            to: { t: 'player', who: { t: 'self' } },
            amount: 5,
            tags: ['self'],
            flags: { unreducible: true, unavoidable: true },
          },
          {
            t: 'createToken',
            equip: true,
            token: { t: 'choose', kind: 'relic', chooser: { t: 'self' } },
          },
        ],
      },
    },
  ],
};

export const terrablazeRebuild: CardDef = {
  id: 'earth/terrablaze_rebuild',
  name: 'テラブレイズ・リビルド',
  god: 'earth',
  types: ['戦術', '鍛造'],
  text:
    '武器か防具を合わせて4つまでと、手札のカードを3枚まで選択する。\n' +
    'それらすべてを捨て、選択した枚数に等しい数の神器ではない武器か防具を生成し、装備する。\n' +
    '同じ装備は3つまで同時に生成できる。\n' +
    'さらに、あなたが5枚以上のカードを選んでいたなら、神器を生成し装備してもよい。',
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'let',
        name: 'gear',
        select: {
          of: 'token',
          sel: {
            t: 'choose',
            count: 4,
            upTo: true,
            chooser: { t: 'self' },
            filter: { kind: ['weapon', 'armor'], owner: { t: 'self' } },
          },
        },
        then: {
          t: 'let',
          name: 'cards',
          select: {
            of: 'card',
            sel: {
              t: 'choose',
              count: 3,
              upTo: true,
              chooser: { t: 'self' },
              from: { zone: 'hand', owner: { t: 'self' } },
            },
          },
          then: {
            t: 'seq',
            of: [
              { t: 'destroyToken', tokens: { t: 'var', name: 'gear' }, to: { zone: 'graveyard', owner: { t: 'self' } } },
              {
                t: 'moveCards',
                cards: { t: 'var', name: 'cards' },
                to: { zone: 'graveyard', owner: { t: 'self' } },
              },
              {
                t: 'createToken',
                equip: true,
                count: { t: 'add', a: { t: 'countOf', name: 'gear' }, b: { t: 'countOf', name: 'cards' } },
                token: { t: 'choose', kind: ['weapon', 'armor'], chooser: { t: 'self' }, excludeRelic: true },
              },
              {
                t: 'if',
                cond: {
                  t: 'cmp',
                  a: { t: 'add', a: { t: 'countOf', name: 'gear' }, b: { t: 'countOf', name: 'cards' } },
                  op: '>=',
                  b: 5,
                },
                then: {
                  t: 'optional',
                  chooser: { t: 'self' },
                  body: { t: 'createToken', equip: true, token: { t: 'choose', kind: 'relic', chooser: { t: 'self' } } },
                },
              },
            ],
          },
        },
      },
    },
  ],
  note: 'let を2段重ねて2種類の選択を束縛し、countOf で合計枚数を出す。「同じ装備は3つまで」は TokenDef.maxCopies 側で担保する。',
};

export const clearSkySweep: CardDef = {
  id: 'earth/clear_sky_sweep',
  name: '掃天快晴',
  god: 'earth',
  types: ['戦術', '天候'],
  text:
    '天候が炎天でないなら晴に変更する。すでに晴であるなら、炎天に変化させる。\n' +
    '天候を晴に変えたなら、カードを1枚引く。',
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'if',
        cond: { t: 'weatherIs', weather: 'clear' },
        then: { t: 'setWeather', weather: 'blaze' },
        else: {
          t: 'if',
          cond: { t: 'not', of: { t: 'weatherIs', weather: 'blaze' } },
          then: {
            t: 'seq',
            of: [
              { t: 'setWeather', weather: 'clear' },
              { t: 'draw', player: { t: 'self' }, count: 1 },
            ],
          },
        },
      },
    },
  ],
};

export const forgeBladeFairSky: CardDef = {
  id: 'earth/forge_blade_fair_sky',
  name: '鍛刃天晴',
  god: 'earth',
  types: ['天候', '鍛造'],
  text: '神器以外の武器か防具1つを生成する。\nその後、天候が晴れか炎天でないなら晴れにする。',
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          {
            t: 'createToken',
            equip: true,
            token: { t: 'choose', kind: ['weapon', 'armor'], chooser: { t: 'self' }, excludeRelic: true },
          },
          {
            t: 'if',
            cond: { t: 'not', of: { t: 'weatherIs', weather: ['clear', 'blaze'] } },
            then: { t: 'setWeather', weather: 'clear' },
          },
        ],
      },
    },
  ],
};

export const blazingSpirit: CardDef = {
  id: 'earth/blazing_spirit',
  name: '気炎万丈',
  god: 'earth',
  types: ['天候', '防御'],
  text:
    '常在＜炎天のダメージにダメージボーナスが付与される＞\n' +
    '天候が晴れか炎天でないなら晴れにする。天候が晴れの場合、天候を炎天に変える。\n' +
    'あなたはこのゲーム中、炎天の効果を受けなくなる。',
  keywords: ['static'],
  abilities: [
    {
      kind: 'continuous',
      active: 'onStack',
      mod: {
        t: 'damageDelta',
        amount: { t: 'cycle' },
        who: { t: 'each' },
        direction: 'taken',
        tags: ['weather'],
      },
    },
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          {
            t: 'if',
            cond: { t: 'weatherIs', weather: 'clear' },
            then: { t: 'setWeather', weather: 'blaze' },
            else: {
              t: 'if',
              cond: { t: 'not', of: { t: 'weatherIs', weather: 'blaze' } },
              then: { t: 'setWeather', weather: 'clear' },
            },
          },
          {
            t: 'grantContinuous',
            duration: 'thisGame',
            mod: { t: 'weatherImmune', who: { t: 'self' }, weather: 'blaze' },
          },
        ],
      },
    },
  ],
  note: '天候ダメージにサイクルボーナスを乗せる＝ damageDelta の amount に {t:\'cycle\'} を入れる。環境を過激化させて自分だけ適応するカード。',
};

export const finalAttack: CardDef = {
  id: 'earth/final_attack',
  name: 'ファイナルアタック',
  god: 'earth',
  types: ['特殊勝利', '戦術'],
  text:
    'あなたと相手のライフが9以下のときのみプレイできる。\n' +
    '戦技（打撃）を行う。\n' +
    'この戦技で相手にダメージを与えたなら、あなたは勝利する。',
  play: {
    cond: {
      t: 'and',
      of: [
        { t: 'cmp', a: { t: 'life', of: { t: 'self' } }, op: '<=', b: 9 },
        { t: 'cmp', a: { t: 'life', of: { t: 'opponent' } }, op: '<=', b: 9 },
      ],
    },
  },
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'bind',
        name: 'dealt',
        of: { t: 'performAction', action: 'earth/strike' },
        then: {
          t: 'if',
          cond: { t: 'cmp', a: { t: 'var', name: 'dealt' }, op: '>=', b: 1 },
          then: { t: 'win', player: { t: 'self' } },
        },
      },
    },
  ],
};

export const ambush: CardDef = {
  id: 'earth/ambush',
  name: '騙し討ち',
  god: 'earth',
  types: ['戦術'],
  text:
    '瞬発\n' +
    '順番確定フェイズの開始時、これが手札にあるならプレイしてもよい。\n' +
    'あなたのコントロールしているカードを一つ選び、スタックの一番上に置く。',
  keywords: ['instant'],
  play: { timing: ['orderPhase'] },
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'moveStackItem',
        to: 'top',
        by: { t: 'self' },
        item: { t: 'choose', count: 1, chooser: { t: 'self' }, filter: { controller: { t: 'self' } } },
      },
    },
  ],
  note: '順番確定フェイズを使う唯一のカード。PlayRule.timing がこの1枚のために要る（雷雲も同フェイズ）。',
};

// ============================================================
// 生命の神 — 設定シートの22枚すべて
// ミニオンは「種族ごとの数」だけで管理する（個体ID・体力・攻撃力なし）
// ============================================================

export const gloriousTriumph: CardDef = {
  id: 'life/glorious_triumph',
  name: '栄光の凱旋',
  god: 'life',
  types: ['ドロー'],
  text:
    '常在＜攻撃指令により人でダメージを与えたとき、カードを1枚引く。＞\n' +
    'このサイクル攻撃指令によりダメージを与えていたなら、カードを1枚引く。',
  keywords: ['static'],
  abilities: [
    {
      kind: 'triggered',
      active: 'onStack',
      when: { on: 'damageDealt', tags: ['attackOrder'], species: { is: 'human' } },
      effect: { t: 'draw', player: { t: 'self' }, count: 1 },
    },
    {
      kind: 'onResolve',
      effect: {
        t: 'if',
        cond: {
          t: 'cmp',
          a: {
            t: 'countEvent',
            event: 'damageDealt',
            scope: 'cycle',
            measure: 'units',
            by: { t: 'self' },
            tags: ['attackOrder'],
          },
          op: '>=',
          b: 1,
        },
        then: { t: 'draw', player: { t: 'self' }, count: 1 },
      },
    },
  ],
  note: '「攻撃指令により**人で**」— ダメージに種族が載っていないと書けない。攻撃指令側で damage.species を付けている。',
};

export const soulHarvest: CardDef = {
  id: 'life/soul_harvest',
  name: 'ソウルハーヴェスト',
  god: 'life',
  types: ['ドロー'],
  text: 'カードを1枚引く。\nミニオンを1種類選び、2体生贄に捧げてもよい。そうしたなら、カードを1枚引く。',
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          { t: 'draw', player: { t: 'self' }, count: 1 },
          {
            t: 'optional',
            chooser: { t: 'self' },
            body: {
              t: 'seq',
              of: [
                {
                  t: 'sacrificeMinion',
                  species: { t: 'choose', chooser: { t: 'self' }, onlyExisting: true },
                  count: 2,
                },
                { t: 'draw', player: { t: 'self' }, count: 1 },
              ],
            },
          },
        ],
      },
    },
  ],
};

export const lifeRecall: CardDef = {
  id: 'life/life_recall',
  name: 'ライフリコール',
  god: 'life',
  types: ['ドロー', '回復'],
  text:
    'このサイクル死亡した死霊以外のミニオン1種類につき1枚カードを引き、\n' +
    'カードを引いた数に等しいライフを回復する。',
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'bind',
        name: 'drew',
        of: {
          t: 'draw',
          player: { t: 'self' },
          // 「体数」ではなく「種類数」を数える
          count: {
            t: 'countSpeciesKinds',
            event: 'minionDied',
            scope: 'cycle',
            of: { t: 'self' },
            species: { not: 'wraith' },
          },
        },
        then: { t: 'heal', to: { t: 'self' }, amount: { t: 'var', name: 'drew' } },
      },
    },
  ],
  note: 'countSpeciesKinds は体数ではなく種類数。countMinions（体数）と読み違えるとカードパワーが4倍近く変わるので命名を分けた。',
};

export const reincarnation: CardDef = {
  id: 'life/reincarnation',
  name: 'リィンカーネーション',
  god: 'life',
  types: ['ドロー', '戦術'],
  text:
    '墓地から「創命」が名前に含まれるカードを2枚まで選び、手札に加える。\n' +
    '「創命」が名前に含まれるカードが墓地にない場合、カードを1枚引く。',
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'if',
        cond: {
          t: 'cmp',
          a: {
            t: 'countZone',
            of: { zone: 'graveyard', owner: { t: 'self' } },
            filter: { nameContains: '創命' },
          },
          op: '>=',
          b: 1,
        },
        then: {
          t: 'moveCards',
          to: { zone: 'hand', owner: { t: 'self' } },
          cards: {
            t: 'choose',
            count: 2,
            upTo: true,
            chooser: { t: 'self' },
            from: { zone: 'graveyard', owner: { t: 'self' } },
            filter: { nameContains: '創命' },
          },
        },
        else: { t: 'draw', player: { t: 'self' }, count: 1 },
      },
    },
  ],
};

export const heraldOfDarkness: CardDef = {
  id: 'life/herald_of_darkness',
  name: '闇の先触れ',
  god: 'life',
  types: ['ドロー', '天候'],
  text:
    '天候が吹雪なら、カードを1枚引く。\n' +
    '天候を吹雪にする。デッキから創命カードを1枚探し、それを公開して手札に加える。\n' +
    'その後、デッキをシャッフルする。',
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          {
            t: 'if',
            cond: { t: 'weatherIs', weather: 'blizzard' },
            then: { t: 'draw', player: { t: 'self' }, count: 1 },
          },
          { t: 'setWeather', weather: 'blizzard' },
          {
            t: 'moveCards',
            reveal: true,
            to: { zone: 'hand', owner: { t: 'self' } },
            cards: {
              t: 'choose',
              count: 1,
              chooser: { t: 'self' },
              from: { zone: 'deck', owner: { t: 'self' } },
              filter: { nameContains: '創命' },
            },
          },
          { t: 'shuffle', of: { zone: 'deck', owner: { t: 'self' } } },
        ],
      },
    },
  ],
};

export const lifeUltimate: CardDef = {
  id: 'life/ultimate',
  name: '奥義枠（仮）',
  god: 'life',
  types: ['戦術'],
  text:
    '常在＜ミニオンが1種類死亡するか生成されるたび、\n' +
    '相手に軽減されず、回避されない1ダメージを与え、ライフを1回復する。\n' +
    'このダメージにダメージボーナスは適用されない＞\n' +
    'このカードは1サイクルに1枚しかプレイできない。',
  keywords: ['static'],
  play: { limit: { count: 1, per: 'cycle' } },
  abilities: [
    {
      kind: 'triggered',
      active: 'onStack',
      // 「1種類死亡するか生成されるたび」= 複数イベント + 種族単位の粒度
      when: { on: ['minionDied', 'minionCreated'], granularity: 'perSpecies' },
      effect: {
        t: 'seq',
        of: [
          {
            t: 'damage',
            to: { t: 'player', who: { t: 'opponent' } },
            amount: 1,
            flags: { unreducible: true, unavoidable: true, ignoreCycleBonus: true },
          },
          { t: 'heal', to: { t: 'self' }, amount: 1 },
        ],
      },
    },
  ],
  note: 'granularity: perSpecies の唯一の使用例。「1種類につき1回」は perEvent でも perUnit でもない第3の粒度。',
};

export const echoOfSacrifice: CardDef = {
  id: 'life/echo_of_sacrifice',
  name: '犠牲の残り香',
  god: 'life',
  types: ['戦術'],
  text: 'このサイクル中に死亡した死霊以外のミニオンに等しい数の死霊を生成する。\n上限は5体。',
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'createMinion',
        species: 'wraith',
        count: {
          t: 'min',
          a: {
            t: 'countEvent',
            event: 'minionDied',
            scope: 'cycle',
            measure: 'units',
            by: { t: 'self' },
            species: { not: 'wraith' },
          },
          b: 5,
        },
      },
    },
  ],
};

export const reproduction: CardDef = {
  id: 'life/reproduction',
  name: '再生産',
  god: 'life',
  types: ['戦術'],
  text:
    '瞬発\n' +
    '任意の1種類のミニオンを任意の数生贄にし、選んだ種類とは違う種類の1種類のミニオンを生贄にした数生成する。',
  keywords: ['instant'],
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'let',
        name: 'sacrificed',
        select: { of: 'species', sel: { t: 'choose', chooser: { t: 'self' }, onlyExisting: true } },
        then: {
          t: 'bind',
          name: 'n',
          of: {
            t: 'sacrificeMinion',
            species: { t: 'var', name: 'sacrificed' },
            count: { t: 'chooseNumber', chooser: { t: 'self' }, min: 0 },
          },
          then: {
            t: 'createMinion',
            species: { t: 'choose', chooser: { t: 'self' }, exclude: { t: 'var', name: 'sacrificed' } },
            count: { t: 'var', name: 'n' },
          },
        },
      },
    },
  ],
  note: 'let（選択の束縛）と bind（効果の結果の束縛）を両方使う例。',
};

export const birthlightOrShroud: CardDef = {
  id: 'life/birthlight_or_shroud',
  name: '生誕の祝光 / 被覆の闇域',
  god: 'life',
  types: ['戦術'],
  text:
    'プレイするとき、以下から一つ選ぶ。\n' +
    '・常在＜ミニオンを生成するとき、ライフを2回復する。＞\n' +
    '・常在＜ミニオンを1種類選ぶ。選んだミニオンは相手に対象にとられない。＞',
  keywords: ['static'],
  abilities: [
    {
      kind: 'onPlay',
      effect: {
        t: 'modal',
        chooser: { t: 'self' },
        modes: [
          {
            text: '常在＜ミニオンを生成するとき、ライフを2回復する。＞',
            effect: {
              t: 'grantTrigger',
              duration: 'whileOnStack',
              trigger: {
                when: { on: 'minionCreated', subject: { t: 'self' } },
                effect: { t: 'heal', to: { t: 'self' }, amount: 2 },
              },
            },
          },
          {
            text: '常在＜ミニオンを1種類選ぶ。選んだミニオンは相手に対象にとられない。＞',
            effect: {
              t: 'let',
              name: 'protectedSp',
              select: { of: 'species', sel: { t: 'choose', chooser: { t: 'self' } } },
              then: {
                t: 'grantContinuous',
                duration: 'whileOnStack',
                mod: { t: 'untargetable', minions: { t: 'var', name: 'protectedSp' } },
              },
            },
          },
        ],
      },
    },
  ],
  note: '「プレイするとき選ぶ」= onPlay の modal。設定シートの「プレイ時なのは瞬発受けるため」に沿っている。',
};

export const surpriseTactics: CardDef = {
  id: 'life/surprise_tactics',
  name: '奇襲作戦',
  god: 'life',
  types: ['戦術', 'バフ'],
  text:
    '瞬発\n' +
    '天候が吹雪か雷雲なら、あなたはこのサイクル中、\n' +
    '「攻撃指令が対象に取られなくなり、攻撃指令によるダメージは回避できない。」を得る。\n' +
    '攻撃指令をスタックに乗せる。',
  keywords: ['instant'],
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          {
            t: 'if',
            cond: { t: 'weatherIs', weather: ['blizzard', 'thundercloud'] },
            then: {
              t: 'seq',
              of: [
                {
                  t: 'grantContinuous',
                  duration: 'thisCycle',
                  mod: {
                    t: 'untargetable',
                    items: { t: 'all', filter: { actionId: 'life/attackOrder', controller: { t: 'self' } } },
                  },
                },
                {
                  t: 'grantContinuous',
                  duration: 'thisCycle',
                  mod: {
                    t: 'damageFlagGrant',
                    who: { t: 'self' },
                    tags: ['attackOrder'],
                    flags: { unavoidable: true },
                  },
                },
              ],
            },
          },
          { t: 'addToStack', payload: { t: 'action', action: 'life/attackOrder' } },
        ],
      },
    },
  ],
  note: 'StackFilter.actionId で NamedAction を名指しできる。「攻撃指令だけ対象に取られない」はこれがないと書けない。',
};

export const crestOfMajesty: CardDef = {
  id: 'life/crest_of_majesty',
  name: '威光の紋章',
  god: 'life',
  types: ['戦術', 'バフ', '攻撃指令'],
  text:
    '常在＜このカードをスタックに乗せたとき、ミニオン1種類を選ぶ。\n' +
    '選んだミニオンが攻撃指令で与えるダメージを＋3する。重複はしない。＞\n' +
    'このカードをスタックに乗せたとき、攻撃指令をスタックに乗せる。',
  keywords: ['static'],
  abilities: [
    {
      kind: 'onPlay',
      effect: {
        t: 'seq',
        of: [
          {
            t: 'let',
            name: 'buffed',
            select: { of: 'species', sel: { t: 'choose', chooser: { t: 'self' } } },
            then: {
              t: 'grantContinuous',
              duration: 'whileOnStack',
              onceOnly: true,
              mod: {
                t: 'damageDelta',
                amount: 3,
                who: { t: 'self' },
                direction: 'dealt',
                tags: ['attackOrder'],
                species: { is: { t: 'var', name: 'buffed' } },
              },
            },
          },
          { t: 'addToStack', payload: { t: 'action', action: 'life/attackOrder' } },
        ],
      },
    },
  ],
  note: '「重複はしない」= grantContinuous.onceOnly。damageDelta を種族で絞れるのは damage.species があるから。',
};

export const finalDevotion: CardDef = {
  id: 'life/final_devotion',
  name: '最期の献身',
  god: 'life',
  types: ['戦術', '回復'],
  text:
    'スタックに乗せたとき、ミニオン1種類を選ぶ。\n' +
    'あなたのライフを選んだ種類のミニオンがこのサイクル死亡した数と同じだけ回復する。',
  abilities: [
    {
      // 選択はプレイ時、参照は解決時 → let では届かないので snapshot で項目に残す
      kind: 'onPlay',
      effect: {
        t: 'snapshot',
        name: 'devotedSp',
        select: { of: 'species', sel: { t: 'choose', chooser: { t: 'self' } } },
      },
    },
    {
      kind: 'onResolve',
      effect: {
        t: 'heal',
        to: { t: 'self' },
        amount: {
          t: 'countEvent',
          event: 'minionDied',
          scope: 'cycle',
          measure: 'units',
          by: { t: 'self' },
          species: { is: { t: 'var', name: 'devotedSp' } },
        },
      },
    },
  ],
  note: 'snapshot が「ability をまたぐ束縛」を担う。let はひとつの効果ツリー内で閉じるので届かない。',
};

export const whiteCalmBlackPanic: CardDef = {
  id: 'life/white_calm_black_panic',
  name: '白の安穏 / 黒の恐慌',
  god: 'life',
  types: ['戦術', '攻撃', '回復'],
  text:
    '以下の効果から1つを選ぶ。\n' +
    '・あなたのライフを6点回復する。\n' +
    '・相手に4点のダメージを与える。このダメージは軽減されず、回避されない。',
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'modal',
        chooser: { t: 'self' },
        modes: [
          { text: 'あなたのライフを6点回復する。', effect: { t: 'heal', to: { t: 'self' }, amount: 6 } },
          {
            text: '相手に4点のダメージを与える。このダメージは軽減されず、回避されない。',
            effect: {
              t: 'damage',
              to: { t: 'player', who: { t: 'opponent' } },
              amount: 4,
              flags: { unreducible: true, unavoidable: true },
            },
          },
        ],
      },
    },
  ],
};

export const emergencyMuster: CardDef = {
  id: 'life/emergency_muster',
  name: '緊急招集',
  god: 'life',
  types: ['戦術', '攻撃指令', '防御指令'],
  text: '瞬発\n防御指令をスタックに乗せ、攻撃指令をスタックに乗せる。',
  keywords: ['instant'],
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          { t: 'addToStack', payload: { t: 'action', action: 'life/defenseOrder' } },
          { t: 'addToStack', payload: { t: 'action', action: 'life/attackOrder' } },
        ],
      },
    },
  ],
};

export const genesisSwarmingBeasts: CardDef = {
  id: 'life/genesis_swarming_beasts',
  name: '創命：群れなす獣',
  god: 'life',
  types: ['創命', '攻撃指令'],
  text: '瞬発\n魔獣を3体生成する。もしくは死霊を3体生成する。攻撃指令をスタックに乗せる。',
  keywords: ['instant'],
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          {
            t: 'modal',
            chooser: { t: 'self' },
            modes: [
              { text: '魔獣を3体生成する。', effect: { t: 'createMinion', species: 'beast', count: 3 } },
              { text: '死霊を3体生成する。', effect: { t: 'createMinion', species: 'wraith', count: 3 } },
            ],
          },
          { t: 'addToStack', payload: { t: 'action', action: 'life/attackOrder' } },
        ],
      },
    },
  ],
};

export const genesisOfAll: CardDef = {
  id: 'life/genesis_of_all',
  name: '創命：万物創生',
  god: 'life',
  types: ['創命', '攻撃指令', '防御指令'],
  text:
    '任意の種類のミニオンを2体生成する。\n' +
    'このカードをスタックに乗せたとき、攻撃指令か防御指令をスタックに乗せる。',
  abilities: [
    {
      kind: 'onPlay',
      effect: {
        t: 'modal',
        chooser: { t: 'self' },
        modes: [
          {
            text: '攻撃指令をスタックに乗せる。',
            effect: { t: 'addToStack', payload: { t: 'action', action: 'life/attackOrder' } },
          },
          {
            text: '防御指令をスタックに乗せる。',
            effect: { t: 'addToStack', payload: { t: 'action', action: 'life/defenseOrder' } },
          },
        ],
      },
    },
    {
      kind: 'onResolve',
      effect: { t: 'createMinion', species: { t: 'choose', chooser: { t: 'self' } }, count: 2 },
    },
  ],
};

export const genesisHolyLegion: CardDef = {
  id: 'life/genesis_holy_legion',
  name: '創命：神護の聖軍',
  god: 'life',
  types: ['創命', '防御指令'],
  text: '人間を4体生成する。もしくは天使を2体生成する。\nこのカードをスタックに乗せたとき、防御指令をスタックに乗せる。',
  abilities: [
    {
      kind: 'onPlay',
      effect: { t: 'addToStack', payload: { t: 'action', action: 'life/defenseOrder' } },
    },
    {
      kind: 'onResolve',
      effect: {
        t: 'modal',
        chooser: { t: 'self' },
        modes: [
          { text: '人間を4体生成する。', effect: { t: 'createMinion', species: 'human', count: 4 } },
          { text: '天使を2体生成する。', effect: { t: 'createMinion', species: 'angel', count: 2 } },
        ],
      },
    },
  ],
};

export const genesisHealingAngel: CardDef = {
  id: 'life/genesis_healing_angel',
  name: '創命：快癒の天使',
  god: 'life',
  types: ['創命', '防御指令'],
  text: '瞬発\n天使を2体生成する。あなたのライフを3点回復する。\n防御指令をスタックに乗せる。',
  keywords: ['instant'],
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          { t: 'createMinion', species: 'angel', count: 2 },
          { t: 'heal', to: { t: 'self' }, amount: 3 },
          { t: 'addToStack', payload: { t: 'action', action: 'life/defenseOrder' } },
        ],
      },
    },
  ],
};

export const blizzardSurrogate: CardDef = {
  id: 'life/blizzard_surrogate',
  name: '吹雪身代わり',
  god: 'life',
  types: ['天候'],
  text:
    '瞬発\n' +
    '天候を吹雪にする。\n' +
    'このサイクル中、吹雪によるダメージが発生するとき、死霊以外のミニオンが合計3体以上いるなら、吹雪のダメージを無効にする。',
  keywords: ['instant'],
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          { t: 'setWeather', weather: 'blizzard' },
          {
            t: 'grantContinuous',
            duration: 'thisCycle',
            // ダメージが発生する時点で判定する条件付き継続効果
            cond: {
              t: 'cmp',
              a: { t: 'countMinions', of: { t: 'self' }, species: { not: 'wraith' } },
              op: '>=',
              b: 3,
            },
            mod: { t: 'weatherImmune', who: { t: 'self' }, weather: 'blizzard' },
          },
        ],
      },
    },
  ],
  note: 'grantContinuous.cond は「付与するかどうか」ではなく「毎回参照される条件」。ミニオンが減れば無効化も消える。',
};

export const thunderManifest: CardDef = {
  id: 'life/thunder_manifest',
  name: '雷光顕現',
  god: 'life',
  types: ['天候'],
  text:
    '瞬発\n' +
    '天候を雷雲にし、ミニオン1種類を2体生成する。\n' +
    'このサイクル中、雷雲によるカード無効化が行われるなら、無効化を行う代わりにミニオン1体を生贄にしてもよい。',
  keywords: ['instant'],
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          { t: 'setWeather', weather: 'thundercloud' },
          { t: 'createMinion', species: { t: 'choose', chooser: { t: 'self' } }, count: 2 },
          {
            t: 'grantContinuous',
            duration: 'thisCycle',
            mod: {
              t: 'replaceEvent',
              who: { t: 'self' },
              optional: true,
              when: { on: 'weatherNegate' },
              with: {
                t: 'sacrificeMinion',
                species: { t: 'choose', chooser: { t: 'self' }, onlyExisting: true },
                count: 1,
              },
            },
          },
        ],
      },
    },
  ],
  note: 'replaceEvent（汎用置換）の使用例。「Aが行われるなら、代わりにBしてもよい」を1つの形で書ける。',
};

export const flawlessDivineArmy: CardDef = {
  id: 'life/flawless_divine_army',
  name: '瑕疵無き神軍',
  god: 'life',
  types: ['特殊勝利'],
  text: '0サイクル目、1サイクル目はプレイできない。\n人が20体以上ならば勝利する。',
  play: { cond: { t: 'cmp', a: { t: 'cycle' }, op: '>=', b: 2 } },
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'if',
        cond: { t: 'cmp', a: { t: 'countMinions', species: 'human', of: { t: 'self' } }, op: '>=', b: 20 },
        then: { t: 'win', player: { t: 'self' } },
      },
    },
  ],
};

export const crestOfProtection: CardDef = {
  id: 'life/crest_of_protection',
  name: '加護の紋章',
  god: 'life',
  types: ['防御', 'バフ', '防御指令'],
  text:
    '常在＜このカードをスタックに乗せたとき、ミニオン1種類を選ぶ。\n' +
    '選んだミニオンは超過ダメージをすべて軽減する。＞\n' +
    'このカードをスタックに乗せたとき、防御指令をスタックに乗せる。',
  keywords: ['static'],
  abilities: [
    {
      kind: 'onPlay',
      effect: {
        t: 'seq',
        of: [
          {
            t: 'snapshot',
            name: 'guardedSp',
            select: { of: 'species', sel: { t: 'choose', chooser: { t: 'self' } } },
          },
          { t: 'addToStack', payload: { t: 'action', action: 'life/defenseOrder' } },
        ],
      },
    },
    {
      kind: 'continuous',
      active: 'onStack',
      mod: {
        t: 'damageRedirect',
        who: { t: 'self' },
        to: { t: 'minion', species: { t: 'var', name: 'guardedSp' }, owner: { t: 'self' } },
        overflow: 'absorb',
      },
    },
  ],
};

// ============================================================
// 空の神
// ============================================================

export const accelerateGale: CardDef = {
  id: 'sky/accelerate_gale',
  name: 'アクセラレートゲイル',
  god: 'sky',
  types: ['ドロー'],
  text: 'このカードに連続しているあなたのカードか効果の数（このカードを含む）に等しい枚数、カードを引く。上限は2枚。',
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'draw',
        player: { t: 'self' },
        count: {
          t: 'min',
          a: { t: 'consecutiveRun', from: { t: 'this' }, controller: { t: 'self' }, includeSelf: true },
          b: 2,
        },
      },
    },
  ],
};

export const skyEnhance: CardDef = {
  id: 'sky/sky_enhance',
  name: 'スカイエンハンス',
  god: 'sky',
  types: ['戦術', '天候'],
  text:
    'カード1枚を捨てることで、このカードを瞬発を持つかのようにプレイしてもよい。\n' +
    '現在の天候が凪でないなら裏にする。すでに裏なら、カードを1枚ドローする。\n' +
    'このサイクル相手が天候を変化するならそれを1度だけ打ち消す。',
  abilities: [
    {
      kind: 'continuous',
      active: 'inHand',
      mod: {
        t: 'grantKeyword',
        keyword: 'instant',
        scope: 'nextPlay',
        who: { t: 'self' },
        cost: { t: 'discard', player: { t: 'self' }, count: 1 },
      },
    },
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          {
            t: 'if',
            cond: { t: 'weatherSide', side: 'back' },
            then: { t: 'draw', player: { t: 'self' }, count: 1 },
            else: {
              t: 'if',
              cond: { t: 'not', of: { t: 'weatherIs', weather: 'calm' } },
              then: { t: 'setWeather', weather: { t: 'choose', side: 'back' }, flipToBack: true },
            },
          },
          {
            t: 'grantContinuous',
            duration: 'thisCycle',
            mod: { t: 'preventWeatherChange', by: { t: 'opponent' }, times: 1 },
          },
        ],
      },
    },
  ],
};

export const chaseStreaming: CardDef = {
  id: 'sky/chase_streaming',
  name: 'チェイスストリーミング',
  god: 'sky',
  types: ['ドロー'],
  text:
    '天候がいずれかの表であるなら、カードを2枚ドローし、手札から1枚捨てる。\n' +
    '天候がいずれかの裏であるなら、カードを2枚ドローする。',
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          { t: 'draw', player: { t: 'self' }, count: 2 },
          {
            t: 'if',
            cond: { t: 'weatherSide', side: 'front' },
            then: { t: 'discard', player: { t: 'self' }, count: 1 },
          },
        ],
      },
    },
  ],
};

export const blessingOfSkyWater: CardDef = {
  id: 'sky/blessing_of_sky_water',
  name: '天水の祝福',
  god: 'sky',
  types: ['ドロー', '戦術', '回復', '天候'],
  text:
    '常在＜天候が豪雨なら、あなたは豪雨の影響を受けない。\n' +
    '天候が豪雨なら、カードか効果が解決する度、ライフを1回復する。＞',
  keywords: ['static'],
  abilities: [
    {
      kind: 'continuous',
      active: 'onStack',
      cond: { t: 'weatherIs', weather: 'downpour' },
      mod: { t: 'weatherImmune', who: { t: 'self' }, weather: 'downpour' },
    },
    {
      kind: 'triggered',
      active: 'onStack',
      when: { on: 'resolving', cond: { t: 'weatherIs', weather: 'downpour' } },
      effect: { t: 'heal', to: { t: 'self' }, amount: 1 },
    },
  ],
};

export const weatherTransition: CardDef = {
  id: 'sky/weather_transition',
  name: 'ウェザートランジション',
  god: 'sky',
  types: ['ドロー', '天候'],
  text:
    '任意の天候を選び、表側で適用する。\n' +
    'このサイクル、天候が表側のいずれかに変化するたびカードを1枚ドローする。\n' +
    'この効果は1サイクルに1つしかつかない。',
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          { t: 'setWeather', weather: { t: 'choose', side: 'front' } },
          {
            t: 'grantTrigger',
            duration: 'thisCycle',
            onceOnly: true,
            trigger: {
              when: { on: 'weatherChanged' },
              effect: {
                t: 'if',
                cond: { t: 'weatherSide', side: 'front' },
                then: { t: 'draw', player: { t: 'self' }, count: 1 },
              },
            },
          },
        ],
      },
    },
  ],
};

export const thunderTempest: CardDef = {
  id: 'sky/thunder_tempest',
  name: 'サンダーテンペスト',
  god: 'sky',
  types: ['攻撃'],
  text:
    '相手かミニオンを選び4点のダメージを与える。\n' +
    '天候が雷なら、カードを1枚捨てるたび、これを繰り返してもよい。',
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          { t: 'damage', to: { t: 'chooseEntity', among: ['opponent', 'minion'] }, amount: 4 },
          {
            t: 'if',
            cond: { t: 'weatherIs', weather: 'thundercloud' },
            then: {
              t: 'while',
              chooser: { t: 'self' },
              cost: { t: 'discard', player: { t: 'self' }, count: 1 },
              body: { t: 'damage', to: { t: 'chooseEntity', among: ['opponent', 'minion'] }, amount: 4 },
            },
          },
        ],
      },
    },
  ],
  note: '「〜するたび繰り返してもよい」は while（支払いつきの任意反復）。repeat（固定回数）とは別物として分けた。',
};

export const solarRayRefrain: CardDef = {
  id: 'sky/solar_ray_refrain',
  name: 'ソーラーレイ・リフレイン',
  god: 'sky',
  types: ['戦術', '天候'],
  text:
    '常在＜天候が炎天であるなら、あなたは炎天のダメージを受けず、\n' +
    'あなたがカードをプレイする度、そのカードの上に「相手に軽減不可の2ダメージを与える。」をスタックに追加する。＞',
  keywords: ['static'],
  abilities: [
    {
      kind: 'continuous',
      active: 'onStack',
      cond: { t: 'weatherIs', weather: 'blaze' },
      mod: { t: 'weatherImmune', who: { t: 'self' }, weather: 'blaze' },
    },
    {
      kind: 'triggered',
      active: 'onStack',
      when: {
        on: 'played',
        filter: { controller: { t: 'self' } },
        cond: { t: 'weatherIs', weather: 'blaze' },
      },
      effect: {
        t: 'addToStack',
        position: 'top',
        payload: {
          t: 'effect',
          text: '相手に軽減不可の2ダメージを与える。',
          effect: {
            t: 'damage',
            to: { t: 'player', who: { t: 'opponent' } },
            amount: 2,
            flags: { unreducible: true },
          },
        },
      },
    },
  ],
};

export const loopTheLoop: CardDef = {
  id: 'sky/loop_the_loop',
  name: 'ループ・ザ・ループ',
  god: 'sky',
  types: ['防御', '回復'],
  text:
    '瞬発\n' +
    'あなたの手札に等しい枚数まで、スタックからあなたのカードを手札に戻す。\n' +
    'これにより手札に戻したカードの枚数に等しいライフを回復する。',
  keywords: ['instant'],
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'bind',
        name: 'returned',
        of: {
          t: 'moveStackToZone',
          to: { zone: 'hand', owner: { t: 'self' } },
          item: {
            t: 'choose',
            upTo: true,
            chooser: { t: 'self' },
            filter: { controller: { t: 'self' } },
            count: { t: 'countZone', of: { zone: 'hand', owner: { t: 'self' } } },
          },
        },
        then: { t: 'heal', to: { t: 'self' }, amount: { t: 'countOf', name: 'returned' } },
      },
    },
  ],
  note: 'bind した集合の要素数は countOf で読む。数値束縛の {t:\'var\'} と使い分ける。',
};

export const windInterrupt: CardDef = {
  id: 'sky/wind_interrupt',
  name: 'ウィンドインタラプト',
  god: 'sky',
  types: ['防御'],
  text:
    'このカードをスタックに乗せたとき、「ウィンドインタラプト」と名の付くカード以外の自分のカードを選んでもよい。\n' +
    'そうしたならこのカードを選んだカードの位置に置き、選んだカードは手札に戻す。\n' +
    'このカードの一つ下にある相手のカードか効果が与えるダメージを6点軽減する。',
  abilities: [
    {
      kind: 'onPlay',
      effect: {
        t: 'optional',
        chooser: { t: 'self' },
        body: {
          t: 'let',
          name: 'swapped',
          select: {
            of: 'stack',
            sel: {
              t: 'choose',
              count: 1,
              chooser: { t: 'self' },
              filter: {
                controller: { t: 'self' },
                kind: 'card',
                not: { nameContains: 'ウィンドインタラプト' },
              },
            },
          },
          then: {
            t: 'seq',
            of: [
              { t: 'moveStackItem', item: { t: 'this' }, to: 'replace', relativeTo: { t: 'var', name: 'swapped' } },
              {
                t: 'moveStackToZone',
                item: { t: 'var', name: 'swapped' },
                to: { zone: 'hand', owner: { t: 'self' } },
              },
            ],
          },
        },
      },
    },
    {
      kind: 'continuous',
      active: 'onStack',
      mod: {
        t: 'damageReduction',
        amount: 6,
        who: { t: 'self' },
        sourceFilter: { is: { t: 'below', of: { t: 'this' } }, controller: { t: 'opponent' } },
      },
    },
  ],
  note: 'StackFilter.not の使用例。「〜と名の付くカード以外」をデータで表現できるようになった。',
};

export const serenity: CardDef = {
  id: 'sky/serenity',
  name: '明鏡止水',
  god: 'sky',
  types: ['特殊勝利'],
  text:
    '瞬発\n' +
    'レゾナンスを行う。\n' +
    '天候が凪でないなら天候を凪に変える。\n' +
    '凪に変わるのが5回目以降ならあなたは勝利する。',
  keywords: ['instant'],
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          { t: 'performAction', action: 'sky/resonance' },
          {
            t: 'if',
            cond: { t: 'not', of: { t: 'weatherIs', weather: 'calm' } },
            then: { t: 'setWeather', weather: 'calm' },
          },
          {
            t: 'if',
            cond: {
              t: 'cmp',
              a: {
                t: 'countEvent',
                event: 'weatherChanged',
                scope: 'game',
                measure: 'events',
                weather: 'calm',
              },
              op: '>=',
              b: 5,
            },
            then: { t: 'win', player: { t: 'self' } },
          },
        ],
      },
    },
  ],
  note: 'countEvent.weather で「凪に変わった回数」を数える。空の特殊勝利「累計20回天候が変わった」も同じ仕組みで書ける。',
};

export const extremeVelocity: CardDef = {
  id: 'sky/extreme_velocity',
  name: 'エクストリームベロシティ',
  god: 'sky',
  types: ['防御', '回避'],
  text:
    '瞬発\n' +
    'このサイクル中、あなたのカードか効果を解決する度回避1を得る。\n' +
    'このカードで得られる回避の上限は6。\n' +
    'さらに、あなたの回避が5以上になるなら、あなたは吹雪のダメージを無効化する。',
  keywords: ['instant'],
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'grantTrigger',
        duration: 'thisCycle',
        trigger: {
          when: { on: 'resolving', filter: { controller: { t: 'self' } } },
          effect: {
            t: 'gainStatus',
            player: { t: 'self' },
            kind: 'evasion',
            amount: 1,
            duration: 'thisCycle',
            capFromThisSource: 6,
          },
        },
      },
    },
    {
      kind: 'continuous',
      active: 'always',
      cond: { t: 'cmp', a: { t: 'status', kind: 'evasion', of: { t: 'self' } }, op: '>=', b: 5 },
      mod: { t: 'weatherImmune', who: { t: 'self' }, weather: 'blizzard' },
    },
  ],
  note: 'capFromThisSource は「このカードで得られる回避の上限」= 発生源ごとの累積上限。全体の上限ではない点に注意。',
};

export const swiftManeuver: CardDef = {
  id: 'sky/swift_maneuver',
  name: 'スウィフトマニューバー',
  god: 'sky',
  types: ['防御', '回避'],
  text: 'あなたは回避3を得る。このサイクル中、カードを引く度に回避1を得る。',
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          { t: 'gainStatus', player: { t: 'self' }, kind: 'evasion', amount: 3, duration: 'thisCycle' },
          {
            t: 'grantTrigger',
            duration: 'thisCycle',
            trigger: {
              when: { on: 'drawn', subject: { t: 'self' } },
              effect: { t: 'gainStatus', player: { t: 'self' }, kind: 'evasion', amount: 1, duration: 'thisCycle' },
            },
          },
        ],
      },
    },
  ],
  note: '誘発の粒度は既定 perEvent（1回のドロー効果につき1回）なので、設定シートの「複数枚引いても1」がそのまま成立する。1枚ごとに発火させたい場合だけ granularity: \'perUnit\' を明示する。',
};

export const masterfulLeap: CardDef = {
  id: 'sky/masterful_leap',
  name: '熟達した跳躍',
  god: 'sky',
  types: ['戦術', '天候'],
  text:
    '瞬発\n' +
    '以下の効果から1つを選ぶ。\n' +
    '・レゾナンスを1回行う。\n' +
    '・スタック上のあなたのカードを1枚手札に戻す。',
  keywords: ['instant'],
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'modal',
        chooser: { t: 'self' },
        modes: [
          { text: 'レゾナンスを1回行う。', effect: { t: 'performAction', action: 'sky/resonance' } },
          {
            text: 'スタック上のあなたのカードを1枚手札に戻す。',
            effect: {
              t: 'moveStackToZone',
              item: { t: 'choose', count: 1, chooser: { t: 'self' }, filter: { controller: { t: 'self' }, kind: 'card' } },
              to: { zone: 'hand', owner: { t: 'self' } },
            },
          },
        ],
      },
    },
  ],
};

export const celestialDisaster: CardDef = {
  id: 'sky/celestial_disaster',
  name: 'セレスティアルディザスター',
  god: 'sky',
  types: ['攻撃', '天候', '奥義'],
  text:
    '瞬発\n' +
    '相手かミニオンを選び3点のダメージを与える。\n' +
    'このサイクル中に天候が変化していたなら、相手に3点のダメージを与える。\n' +
    '現在の天候がいずれかの裏であるなら、相手に6点のダメージを与える。\n' +
    'このカードは1サイクルに1枚しかプレイできない。',
  keywords: ['instant'],
  play: { limit: { count: 1, per: 'cycle' } },
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          { t: 'damage', to: { t: 'chooseEntity', among: ['opponent', 'minion'] }, amount: 3 },
          {
            t: 'if',
            cond: {
              t: 'cmp',
              a: { t: 'countEvent', event: 'weatherChanged', scope: 'cycle', measure: 'events' },
              op: '>=',
              b: 1,
            },
            then: { t: 'damage', to: { t: 'player', who: { t: 'opponent' } }, amount: 3 },
          },
          {
            t: 'if',
            cond: { t: 'weatherSide', side: 'back' },
            then: { t: 'damage', to: { t: 'player', who: { t: 'opponent' } }, amount: 6 },
          },
        ],
      },
    },
  ],
};


export const flawlessFeather: CardDef = {
  id: 'sky/flawless_feather',
  name: 'フローレスフェザー',
  god: 'sky',
  types: ['攻撃'],
  text:
    'このカードをスタックに乗せたとき「相手に2ダメージを与える。」をスタックに乗せる。\n' +
    '相手かミニオンを選び3点のダメージを与える。\n' +
    'このカードを解決するとき、このサイクル中にあなたがダメージを受けていないなら、相手に3点のダメージを与える。',
  abilities: [
    {
      kind: 'onPlay',
      effect: {
        t: 'addToStack',
        payload: {
          t: 'effect',
          text: '相手に2ダメージを与える。',
          effect: { t: 'damage', to: { t: 'player', who: { t: 'opponent' } }, amount: 2 },
        },
      },
    },
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          { t: 'damage', to: { t: 'chooseEntity', among: ['opponent', 'minion'] }, amount: 3 },
          {
            t: 'if',
            cond: {
              t: 'cmp',
              a: {
                t: 'countEvent',
                event: 'damageTaken',
                scope: 'cycle',
                measure: 'units',
                by: { t: 'self' },
              },
              op: '==',
              b: 0,
            },
            then: { t: 'damage', to: { t: 'player', who: { t: 'opponent' } }, amount: 3 },
          },
        ],
      },
    },
  ],
};

export const rapidBurst: CardDef = {
  id: 'sky/rapid_burst',
  name: 'ラピッドバースト（仮）',
  god: 'sky',
  types: ['攻撃', '戦術'],
  text: '相手に3点のダメージを与える。\nこれにより与えたダメージに等しい回避を得る。',
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'bind',
        name: 'dealt',
        of: { t: 'damage', to: { t: 'player', who: { t: 'opponent' } }, amount: 3 },
        then: {
          t: 'gainStatus',
          player: { t: 'self' },
          kind: 'evasion',
          amount: { t: 'var', name: 'dealt' },
          duration: 'thisCycle',
        },
      },
    },
  ],
  note: '設定シートでは「元ラピバ」枠として入れ替え検討中のカード。現行テキスト（3点＋ダメージ分回避）で暫定データ化した。',
};

export const lethalityBlizzard: CardDef = {
  id: 'sky/lethality_blizzard',
  name: 'リーサリティブリザード',
  god: 'sky',
  types: ['攻撃', '天候'],
  text: '相手に4点のダメージを与える。\nレゾナンスを1回行う。\n天候を吹雪に変更する。',
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          { t: 'damage', to: { t: 'player', who: { t: 'opponent' } }, amount: 4 },
          { t: 'performAction', action: 'sky/resonance' },
          { t: 'setWeather', weather: 'blizzard' },
        ],
      },
    },
  ],
  note: 'レゾナンスは現在の天候で分岐するので、天候変更の「前」に行うか「後」に行うかで結果が変わる。テキストの順序どおり前に置いている。',
};

export const ragingSky: CardDef = {
  id: 'sky/raging_sky',
  name: 'レイジングスカイ',
  god: 'sky',
  types: ['戦術'],
  text:
    '瞬発\n' +
    'このサイクル中、回避が1以上あるならあなたのカードと効果は雷の対象外になる。\n' +
    '天候を雷に変更する。',
  keywords: ['instant'],
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          {
            t: 'grantContinuous',
            duration: 'thisCycle',
            cond: { t: 'cmp', a: { t: 'status', kind: 'evasion', of: { t: 'self' } }, op: '>=', b: 1 },
            mod: {
              t: 'replaceEvent',
              who: { t: 'self' },
              when: { on: 'weatherNegate', filter: { controller: { t: 'self' } } },
            },
          },
          { t: 'setWeather', weather: 'thundercloud' },
        ],
      },
    },
  ],
  note: 'replaceEvent の with を省略すると「単に打ち消す」。雷光顕現（代わりに生贄）と同じ構文で「対象外になる」を書ける。',
};

export const resonanceRegion: CardDef = {
  id: 'sky/resonance_region',
  name: 'レゾナンスリージョン',
  god: 'sky',
  types: ['戦術', '手札増強'],
  text:
    'このカードをスタックに乗せたとき、レゾナンスを1つスタックに乗せる。\n' +
    'このカードがバウンスされたとき、このカードの位置にレゾナンスを置く。',
  abilities: [
    {
      kind: 'onPlay',
      effect: { t: 'addToStack', payload: { t: 'action', action: 'sky/resonance' } },
    },
    {
      kind: 'triggered',
      active: 'onStack',
      when: { on: 'bounced', subject: { t: 'this' } },
      effect: {
        t: 'addToStack',
        position: 'above',
        relativeTo: { t: 'this' },
        payload: { t: 'action', action: 'sky/resonance' },
      },
    },
  ],
  note: 'EventKind bounced が要る唯一のカード。バウンスは moveStackToZone(hand) の結果なので、その副作用としてイベントを発火させる。',
};

export const quickChange: CardDef = {
  id: 'sky/quick_change',
  name: 'クイックチェンジ',
  god: 'sky',
  types: ['戦術', '天候'],
  text: '瞬発\n任意の表の天候に変える。',
  keywords: ['instant'],
  abilities: [
    { kind: 'onResolve', effect: { t: 'setWeather', weather: { t: 'choose', side: 'front' } } },
  ],
};

export const freeDivineWings: CardDef = {
  id: 'sky/free_divine_wings',
  name: '自在の神翼',
  god: 'sky',
  types: ['戦術', '天候', '攻撃補助', '防御'],
  text:
    '瞬発\n' +
    'このサイクル中、\n' +
    '晴/炎天なら自分だけ回避できるようになる。\n' +
    '雨/豪雨なら自分の攻撃だけダメージボーナスが適用される。\n' +
    '吹雪なら自分だけ最後の5ダメージを無効化する。',
  keywords: ['instant'],
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'if',
        cond: { t: 'weatherIs', weather: ['clear', 'blaze'] },
        then: {
          t: 'grantContinuous',
          duration: 'thisCycle',
          mod: { t: 'weatherImmune', who: { t: 'self' }, weather: ['clear', 'blaze'] },
        },
        else: {
          t: 'if',
          cond: { t: 'weatherIs', weather: ['rain', 'downpour'] },
          then: {
            t: 'grantContinuous',
            duration: 'thisCycle',
            mod: { t: 'damageDelta', amount: { t: 'cycle' }, who: { t: 'self' }, direction: 'dealt' },
          },
          else: {
            t: 'grantContinuous',
            duration: 'thisCycle',
            mod: { t: 'damagePrevention', who: { t: 'self' }, tags: ['weather'], weather: 'blizzard' },
          },
        },
      },
    },
  ],
  note: '「晴なら攻撃が必ず当たる＝自分だけ回避できる」は、晴の効果（必中）から自分を免除する形＝ weatherImmune で表す。',
};

export const weatherControl: CardDef = {
  id: 'sky/weather_control',
  name: 'ウェザーコントロール',
  god: 'sky',
  types: ['戦術', '天候'],
  text: '任意の表の天候に変える。\nまたは、天候が凪でないなら裏返してもよい。',
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'modal',
        chooser: { t: 'self' },
        modes: [
          {
            text: '任意の表の天候に変える。',
            effect: { t: 'setWeather', weather: { t: 'choose', side: 'front' } },
          },
          {
            text: '天候が凪でないなら裏返す。',
            effect: {
              t: 'if',
              cond: { t: 'not', of: { t: 'weatherIs', weather: 'calm' } },
              then: { t: 'setWeather', weather: { t: 'choose', side: 'back' }, flipToBack: true },
            },
          },
        ],
      },
    },
  ],
};

// ============================================================
// 創造の神 — 「handlerの神」
// 設定シートの案はほぼ全てがルール・構造の書き換えなので、
// DSL で書けるものだけデータ化し、残りは handler に集約する。
// ============================================================

export const dejaVu: CardDef = {
  id: 'creation/deja_vu',
  name: 'デジャヴ',
  god: 'creation',
  types: ['戦術', 'コピー'],
  text:
    'このゲームで使用済みとなったカードから5枚を選び、2枚を手札に加える。\n' +
    '残りをあなたのデッキに加えて、シャッフルする。',
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'seq',
        of: [
          {
            t: 'moveCards',
            to: { zone: 'staging', owner: { t: 'self' } },
            cards: { t: 'choose', count: 5, chooser: { t: 'self' }, from: { zone: 'graveyard', owner: { t: 'each' } } },
          },
          {
            t: 'moveCards',
            cards: { t: 'choose', count: 2, chooser: { t: 'self' }, from: { zone: 'staging', owner: { t: 'self' } } },
            to: { zone: 'hand', owner: { t: 'self' } },
          },
          {
            t: 'moveCards',
            cards: { t: 'all', from: { zone: 'staging', owner: { t: 'self' } } },
            to: { zone: 'deck', owner: { t: 'self' } },
          },
          { t: 'shuffle', of: { zone: 'deck', owner: { t: 'self' } } },
        ],
      },
    },
  ],
  note: '創造でも DSL で書けるものはある。staging の2例目。相手の墓地も選べるので owner は each。',
};

export const stackSplit: CardDef = {
  id: 'creation/stack_split',
  name: 'スタック分割',
  god: 'creation',
  types: ['戦術'],
  text:
    'このカードは1サイクルに1枚しかプレイできない。\n' +
    'このカードを最初のカードとした新しいスタックを作成する。\n' +
    'スタックが複数あるとき、互いのプレイヤーはどちらのスタックにカードをプレイしても良い。\n' +
    '解決フェイズにあたり、このカードがプレイされたスタックを先に全て解決する。',
  play: { limit: { count: 1, per: 'cycle' } },
  abilities: [
    { kind: 'onPlay', effect: { t: 'handler', id: 'creation/stackSplit', params: { resolveFirst: true } } },
  ],
  note: 'handler 基準①: スタックの数というゲームの基礎構造を変える。GameState.stacks[] を前提にしてあるので handler 側の実装は素直に書ける。',
};

export const chaosFortune: CardDef = {
  id: 'creation/chaos_fortune',
  name: 'ケイオス・フォーチュン',
  god: 'creation',
  types: ['妨害', '特殊'],
  text: '戦場にある全てのデッキをリシャッフルする。以降、デッキは共通となる。',
  abilities: [
    { kind: 'onResolve', effect: { t: 'handler', id: 'creation/mergeDecks' } },
  ],
  note: 'handler 基準①: デッキの所有という基礎構造を変える。GameState.decks[] を前提にしてあるので後付け改修にはならない。',
};

export const justKill: CardDef = {
  id: 'creation/just_kill',
  name: 'ジャストキル',
  god: 'creation',
  types: ['戦術', '常在'],
  text:
    'このサイクル、あなたがカードの効果によって何らかの数値を0にするなら、\n' +
    'それは打ち消されず、それは対象に取られず、それが解決するたびカードを1枚引き、ライフを5点回復する。',
  keywords: ['static'],
  abilities: [
    {
      kind: 'onResolve',
      effect: {
        t: 'grantContinuous',
        duration: 'thisCycle',
        mod: { t: 'handler', id: 'creation/zeroWatcher' },
      },
    },
  ],
  note: 'handler 基準③: 「何らかの数値を0にするなら」はエンジンの全数値操作を監視する必要があり、DSL に入れると全効果に概念が漏れる。',
};

// ============================================================
// 神の定義 — カードに属さない神固有のパッシブ／初期セットアップ
// ============================================================

export const gods: GodDef[] = [
  {
    id: 'earth',
    name: '大地の神',
    actions: ['earth/slash', 'earth/thrust', 'earth/strike'],
    tokens: ['earth/sword', 'earth/spear', 'earth/hammer', 'earth/armor_obsidian', 'earth/armor_mantle'],
    passives: [
      {
        kind: 'continuous',
        active: 'always',
        mod: { t: 'damageDelta', amount: 1, who: { t: 'self' }, direction: 'dealt' },
      },
      {
        kind: 'continuous',
        active: 'always',
        mod: { t: 'damageDelta', amount: 1, who: { t: 'self' }, direction: 'taken' },
      },
      {
        kind: 'triggered',
        active: 'always',
        when: { on: 'cycleStart' },
        effect: { t: 'gainStatus', player: { t: 'self' }, kind: 'shield', amount: 5, duration: 'thisTurn' },
      },
    ],
    note: '①攻勢＝与ダメ/被ダメ+1 ②難攻不落＝ターン開始時シールド5。企画書④パッシブ能力案より。',
  },
  {
    id: 'sea',
    name: '海の神',
    actions: [],
    passives: [],
    note: '予知領域（Zone: foresight）を持つことが実質のパッシブ。ゾーンとして表現済み。',
  },
  {
    id: 'sky',
    name: '空の神',
    actions: ['sky/resonance'],
    passives: [],
  },
  {
    id: 'life',
    name: '生命の神',
    actions: ['life/attackOrder', 'life/defenseOrder'],
    species: ['human', 'angel', 'wraith', 'beast'],
    passives: [
      {
        kind: 'triggered',
        active: 'always',
        when: { on: 'cycleStart' },
        effect: {
          t: 'seq',
          of: [
            { t: 'createMinion', species: 'human', count: 2 },
            { t: 'createMinion', species: 'angel', count: 2 },
            { t: 'createMinion', species: 'wraith', count: 2 },
            { t: 'createMinion', species: 'beast', count: 2 },
          ],
        },
      },
    ],
    note: 'テスト仕様「ターン開始時ドロー前に全種2体生成」。ドローフェイズより前に発火する必要があるため、cycleStart の中でも順序指定が要る（フェイズ内順序はエンジン側の課題）。',
  },
  {
    id: 'creation',
    name: '創造の神',
    actions: [],
    passives: [],
    note: '「handlerの神」。パッシブもルール改変寄りになるため、固まった時点で handler として実装する。',
  },
];

// ============================================================
// エクスポート
// ============================================================

export const sampleActions: NamedActionDef[] = [slash, thrust, strike, attackOrder, defenseOrder, resonance];

export const sampleTokens: TokenDef[] = [
  infernoFury,
  vermilionPierce,
  grandDestruction,
  obsidianGuard,
  scorchingMantle,
];

export const sampleCards: CardDef[] = [
  // 海（設定シート22枚）
  futureChoice,
  floodingWisdom,
  reactiveAquaSphere,
  accumulatingWater,
  domainExpansion,
  dreadfulTidalWave,
  abyssCascade,
  amplifiableShield,
  knownPeril,
  flowingWaterDance,
  embraceOfTheSea,
  splitDimension,
  wisdomVault,
  melancholicRain,
  parallelThinking,
  flashOfInsight,
  questForUnknown,
  terribleVortex,
  currentControl,
  wisdomOfWater,
  waterIllusion,
  requiem,
  // 大地（設定シート22枚）
  combination,
  crushingBlow,
  crimsonIgnition,
  indestructibleWall,
  gutsCard,
  instantForge,
  scarletAnnihilation,
  earthrageEruption,
  boilingLey,
  blazingRush,
  flameForce,
  heavenScorchingFlame,
  rampageChain,
  cruelCarnage,
  burningEarth,
  declarationOfRuin,
  terrablazeRebuild,
  clearSkySweep,
  forgeBladeFairSky,
  blazingSpirit,
  finalAttack,
  ambush,
  // 生命（設定シート22枚）
  gloriousTriumph,
  soulHarvest,
  lifeRecall,
  reincarnation,
  heraldOfDarkness,
  lifeUltimate,
  echoOfSacrifice,
  reproduction,
  birthlightOrShroud,
  surpriseTactics,
  crestOfMajesty,
  finalDevotion,
  whiteCalmBlackPanic,
  emergencyMuster,
  genesisSwarmingBeasts,
  genesisOfAll,
  genesisHolyLegion,
  genesisHealingAngel,
  blizzardSurrogate,
  thunderManifest,
  flawlessDivineArmy,
  crestOfProtection,
  // 空（設定シート22枚）
  accelerateGale,
  skyEnhance,
  chaseStreaming,
  blessingOfSkyWater,
  weatherTransition,
  thunderTempest,
  solarRayRefrain,
  loopTheLoop,
  windInterrupt,
  serenity,
  extremeVelocity,
  swiftManeuver,
  masterfulLeap,
  celestialDisaster,
  flawlessFeather,
  rapidBurst,
  lethalityBlizzard,
  ragingSky,
  resonanceRegion,
  quickChange,
  freeDivineWings,
  weatherControl,
  // 創造（handlerの神）
  dejaVu,
  stackSplit,
  chaosFortune,
  justKill,
];

export const samplePool: CardPool = {
  gods,
  cards: sampleCards,
  tokens: sampleTokens,
  minions,
  actions: sampleActions,
  objectives: sampleObjectives,
};
