/**
 * デッキリスト（人が手で書くテキスト）の読み書き。
 *
 * ```
 * # 大地 / アグロ
 * name: 大地アグロ
 * god: earth
 * objectives: 十連撃の誓約, 一撃必殺, 完全武装の証明
 *
 * 3 紅蓮着火
 * 2 コンビネーション
 * 1 アースレイジ・イラプション
 * ```
 *
 * **ID ではなくカード名で書く。** 92枚すべて名前が重複していないので曖昧さは出ず、
 * `validateDeck` の「同名3枚まで」も名前で数えているので数え方も一致する。
 * 名前が見つからないときは**行番号と候補**を出して落とす（黙って抜けを作らない）。
 *
 * このモジュールはファイルを読まない（ブラウザでも動く）。
 * 読み込みは `src/rules/decks.load.ts`。
 */
import type { CardDef, God, ObjectiveDef } from '../rules/types';
import { EngineError } from './errors';
import { DECK_MAX, DECK_MIN, MAX_COPIES, type DeckList } from './flow';
import type { PoolIndex } from './pool';

/** デッキリストの記述ミス。行番号つきで、直し方が分かる文面にする */
export class DeckListError extends EngineError {}

export interface ParsedDeck extends DeckList {
  /** 表示名。`name:` 省略時はファイル名など呼び出し側が渡した既定値 */
  name: string;
  god: God;
  /** カード定義ID。枚数ぶん展開済み */
  cards: string[];
  objectives: string[];
}

export interface ParseOptions {
  /** `name:` が無いときの表示名 */
  name?: string;
  /** 枚数・同名上限・神の一致の検査を省く（部分的なリストを読むとき） */
  skipValidation?: boolean;
}

const HEADER = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/;
const ENTRY = /^(\d+)\s+(.+)$/;

/** 名前 → 定義。カード名も勝利条件名も一意なので Map で足りる */
function indexByName<T extends { name: string }>(defs: readonly T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const d of defs) m.set(d.name, d);
  return m;
}

/** 打ち間違いの候補。部分一致 → 先頭2文字一致 の順に拾う */
function suggest(input: string, names: Iterable<string>): string[] {
  const all = [...names];
  const hit = all.filter((n) => n.includes(input) || input.includes(n));
  if (hit.length > 0) return hit.slice(0, 3);
  const head = input.slice(0, 2);
  return all.filter((n) => n.startsWith(head)).slice(0, 3);
}

function fail(line: number, message: string, candidates?: string[]): never {
  const tail = candidates && candidates.length > 0 ? `（候補: ${candidates.join(' / ')}）` : '';
  throw new DeckListError(`${line}行目: ${message}${tail}`);
}

/**
 * デッキリストのテキストを読む。
 * 検査はここでも行うが、最終的な正は `validateDeck` と `setupObjectives`。
 * ここで見るのは「人が直せる形のメッセージを出すため」で、定数は engine と共有している。
 */
export function parseDeckList(text: string, pool: PoolIndex, opts: ParseOptions = {}): ParsedDeck {
  const cardsByName = indexByName([...pool.cards.values()]);
  const objectivesByName = indexByName([...pool.objectives.values()]);

  let god: God | undefined;
  let name = opts.name ?? '';
  let objectiveNames: { line: number; name: string }[] = [];
  const entries: { line: number; count: number; def: CardDef }[] = [];

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const body = raw.split('#')[0]!.trim();
    if (body === '') return;

    const header = HEADER.exec(body);
    if (header) {
      const key = header[1]!.toLowerCase();
      const value = header[2]!.trim();
      if (key === 'god') {
        if (!pool.god(value as God)) {
          fail(line, `神 "${value}" が見つからない`, [...pool.gods.keys()]);
        }
        god = value as God;
      } else if (key === 'name') {
        name = value;
      } else if (key === 'objectives') {
        objectiveNames = value
          .split(/[,、]/)
          .map((s) => s.trim())
          .filter(Boolean)
          .map((n) => ({ line, name: n }));
      } else {
        fail(line, `"${key}:" という項目は無い`, ['name', 'god', 'objectives']);
      }
      return;
    }

    const entry = ENTRY.exec(body);
    const count = entry ? Number(entry[1]) : 1;
    const cardName = entry ? entry[2]!.trim() : body;
    const def = cardsByName.get(cardName);
    if (!def) fail(line, `"${cardName}" というカードは無い`, suggest(cardName, cardsByName.keys()));
    if (count < 1) fail(line, `枚数は1以上にする（${count}）`);
    entries.push({ line, count, def });
  });

  if (!god) throw new DeckListError('god: が書かれていない（例: god: earth）');

  const cards: string[] = [];
  const byName = new Map<string, { line: number; count: number }>();
  for (const e of entries) {
    const prev = byName.get(e.def.name);
    byName.set(e.def.name, { line: e.line, count: (prev?.count ?? 0) + e.count });
    for (let k = 0; k < e.count; k++) cards.push(e.def.id);
  }

  const objectives = resolveObjectives(objectiveNames, god, pool, objectivesByName);

  if (!opts.skipValidation) {
    for (const e of entries) {
      if (e.def.god !== god && e.def.god !== 'common') {
        fail(e.line, `"${e.def.name}" は ${e.def.god} のカードなので ${god} のデッキには入らない`);
      }
    }
    for (const [n, v] of byName) {
      if (v.count > MAX_COPIES) fail(v.line, `"${n}" は${MAX_COPIES}枚まで（${v.count}枚）`);
    }
    if (cards.length < DECK_MIN || cards.length > DECK_MAX) {
      throw new DeckListError(`デッキは${DECK_MIN}〜${DECK_MAX}枚（いまは${cards.length}枚）`);
    }
  }

  return { name: name || god, god, cards, objectives };
}

function resolveObjectives(
  given: { line: number; name: string }[],
  god: God,
  pool: PoolIndex,
  byName: Map<string, ObjectiveDef>,
): string[] {
  // 省略時はその神の勝利条件を全部（企画書「採用する最低数は3つ」）
  if (given.length === 0) {
    return [...pool.objectives.values()].filter((o) => o.god === god).map((o) => o.id);
  }
  return given.map(({ line, name }) => {
    const o = byName.get(name);
    if (!o) fail(line, `"${name}" という勝利条件は無い`, suggest(name, byName.keys()));
    if (o.god !== god) fail(line, `"${name}" は ${o.god} の勝利条件なので ${god} では採用できない`);
    return o.id;
  });
}

// ============================================================
// 書き出し
// ============================================================

export interface FormatOptions {
  /** 先頭に置くコメント行（狙いのメモ） */
  comments?: string[];
}

/** `parseDeckList` で読み戻せるテキストにする。並びは最初に現れた順 */
export function formatDeckList(deck: ParsedDeck, pool: PoolIndex, opts: FormatOptions = {}): string {
  const counts = new Map<string, number>();
  for (const id of deck.cards) counts.set(id, (counts.get(id) ?? 0) + 1);

  const lines: string[] = [];
  for (const c of opts.comments ?? []) lines.push(`# ${c}`);
  if (lines.length > 0) lines.push('');
  lines.push(`name: ${deck.name}`);
  lines.push(`god: ${deck.god}`);
  lines.push(`objectives: ${deck.objectives.map((id) => pool.objective(id).name).join(', ')}`);
  lines.push('');
  for (const [id, n] of counts) lines.push(`${n} ${pool.card(id).name}`);
  lines.push('');
  lines.push(`# 合計 ${deck.cards.length} 枚 / ${counts.size} 種類`);
  return lines.join('\n') + '\n';
}
