/**
 * デッキ構築と手札の上限。すべて企画書「基本ルール」の数値。
 *
 * `flow.ts`（`validateDeck` / 手札上限）と `decklist.ts`（人が書くデッキリストの検査）と
 * デッキビルダーの3か所が同じ数字を見る必要がある。
 * `flow.ts` に置いたままだと、デッキリストのパーサがエンジン全体を引き込んでしまい、
 * ブラウザ用に束ねられなかったので独立させた。
 */

/** 初期山札の下限 */
export const DECK_MIN = 30;
/** 初期山札の上限 */
export const DECK_MAX = 40;
/** 同名カードを入れられる枚数 */
export const MAX_COPIES = 3;
/** 手札上限（持ち越せる最大数） */
export const HAND_LIMIT = 10;
/** 採用する特殊勝利条件の最低数（創造の神は企画上もっと多く選べる） */
export const OBJECTIVE_MIN = 3;
