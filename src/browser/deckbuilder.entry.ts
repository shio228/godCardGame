/**
 * デッキビルダーがブラウザで使う面。
 *
 * **ここに載るのはブラウザで動くコードだけ。** `node:fs` に触る
 * `src/rules/decks.load.ts` は絶対に import しない。
 *
 * 肝は**本物のパーサをそのまま使う**こと。画面側で枚数を数え直すと
 * `npm run deck`（CLI）と食い違うので、ビルダーは組み上げたテキストを
 * `parseDeckList` に通して合否を決める。**画面に出る合否とCLIの合否が必ず一致する。**
 *
 * カードデータは効果ツリーまで持つと重いので、表示に要る項目だけを
 * 生成時に埋め込む（`CardIndex`）。`makePool` がそれを `CardPool` の形に戻す。
 * パーサが見るのは名前・神・id だけなので、`abilities: []` を補えば足りる。
 */
import { formatDeckList, parseDeckList, DeckListError, type ParsedDeck } from '../engine/decklist';
import { PoolIndex } from '../engine/pool';
import { DECK_MAX, DECK_MIN, MAX_COPIES, OBJECTIVE_MIN } from '../rules/limits';
import type { CardPool, God, Keyword } from '../rules/types';

/** HTMLに埋め込む、表示に必要なだけのカード情報 */
export interface CardIndexEntry {
  id: string;
  name: string;
  god: God;
  types: string[];
  text: string;
  keywords: Keyword[];
  /** プレイ条件・追加コスト・回数制限を持つか（重いカードの目安） */
  restricted: boolean;
}

export interface ObjectiveIndexEntry {
  id: string;
  name: string;
  god: God;
  initiative: number | 'special';
  text: string;
}

export interface BuilderData {
  cards: CardIndexEntry[];
  objectives: ObjectiveIndexEntry[];
  gods: { id: God; name: string }[];
  /** `decks/*.txt` の中身。最初から読み込めるようにする */
  decks: Record<string, string>;
  limits: { deckMin: number; deckMax: number; maxCopies: number; objectiveMin: number };
}

/** 埋め込んだ索引から、パーサが使える `PoolIndex` を組み立てる */
export function makePool(data: BuilderData): PoolIndex {
  const pool: CardPool = {
    gods: data.gods.map((g) => ({ id: g.id, name: g.name, passives: [], actions: [] })),
    cards: data.cards.map((c) => ({
      id: c.id,
      name: c.name,
      god: c.god,
      types: c.types,
      text: c.text,
      ...(c.keywords.length > 0 ? { keywords: c.keywords } : {}),
      abilities: [],
    })),
    tokens: [],
    minions: [],
    actions: [],
    objectives: data.objectives.map((o) => ({
      id: o.id,
      name: o.name,
      god: o.god,
      initiative: o.initiative,
      text: o.text,
      when: { on: 'continuous' as const },
    })),
  };
  return new PoolIndex(pool);
}

/** 枚数の対（カードID → 枚数）から、読み書きできるデッキの形にする */
export function toDeck(
  name: string,
  god: God,
  counts: Record<string, number>,
  objectives: string[],
): ParsedDeck {
  const cards: string[] = [];
  for (const [id, n] of Object.entries(counts)) {
    for (let k = 0; k < n; k++) cards.push(id);
  }
  return { name, god, cards, objectives };
}

export interface CheckResult {
  ok: boolean;
  /** 直すべきこと。`parseDeckList` が出す行番号つきのメッセージ */
  error?: string;
  text: string;
}

/**
 * デッキをテキストにして、そのテキストを読み直せるか確かめる。
 * **これがビルダーの合否判定のすべて。** 画面側で別に数えたりしない。
 */
export function check(deck: ParsedDeck, pool: PoolIndex, comments: string[]): CheckResult {
  const text = formatDeckList(deck, pool, { comments });
  try {
    parseDeckList(text, pool, { name: deck.name });
    return { ok: true, text };
  } catch (e) {
    const message = e instanceof DeckListError ? e.message : String(e);
    return { ok: false, error: message, text };
  }
}

/** 貼り付けたテキストを読む。エラーは呼び出し側で表示する */
export function load(text: string, pool: PoolIndex): ParsedDeck {
  return parseDeckList(text, pool);
}

export { formatDeckList, parseDeckList, DeckListError, DECK_MIN, DECK_MAX, MAX_COPIES, OBJECTIVE_MIN };
export type { ParsedDeck, PoolIndex };
