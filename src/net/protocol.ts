/**
 * クライアントとサーバが共有する型。
 *
 * **`node:` も DOM も参照しない。** ブラウザ側のバンドルにもサーバ側にも同じものが入る。
 *
 * 選択のやりとりは記録・再生（`src/engine/replay.ts`）と同じ表現にしてある:
 * サーバは**選択肢のラベルだけ**を送り、クライアントは**番号**を返す。
 * `Chooser` の `options[].value` はエンジン内部のオブジェクト（循環参照・巨大・秘匿情報つき）で
 * そのままは送れないが、この形なら送れるうえ、応答をそのまま `RecordedChoice` にできる。
 */
import type { God, PlayerId } from '../rules/types';
import type { ChoiceKind } from '../engine/chooser';
import type { PlayerView } from '../engine/view';

/** 次に必要な選択。**その席の本人にだけ送る**（ラベル自体が手札などの秘匿情報を含む） */
export interface PendingRequest {
  /**
   * 何手目の選択か（＝ここまでに記録された選択の数）。
   * 応答にこの番号を添えてもらうので、二重送信も遅れて届いた古い応答も弾ける。
   */
  index: number;
  t: 'select' | 'number' | 'confirm' | 'order';
  player: PlayerId;
  prompt: string;
  kind?: ChoiceKind;
  /** select / order のときだけ。選択肢の表示名 */
  options?: string[];
  min?: number;
  max?: number;
}

/** クライアントが返す答え。`select`/`order` は番号、`number` は数、`confirm` は真偽 */
export type Answer = number[] | number | boolean;

export type RoomStatus = 'lobby' | 'playing' | 'over';

/** デッキの指定。同梱のプリセットか、貼り付けたテキスト */
export type DeckChoice = { preset: string } | { text: string };

export interface SeatInfo {
  seat: PlayerId;
  name: string;
  ai: boolean;
  ready: boolean;
  god?: God;
  deckName?: string;
}

export interface GameResultInfo {
  winner: PlayerId | 'draw';
  reason?: string;
  cycles: number;
}

/** サーバの応答。**どの操作でも同じ形**を返すので、クライアントは受け取って描き直すだけでよい */
export interface RoomSnapshot {
  room: string;
  version: number;
  status: RoomStatus;
  seats: SeatInfo[];
  vsAi: boolean;
  /** 自分の席（`create` / `join` の直後に配る。以降はクライアントが持っている） */
  you?: { seat: PlayerId; token: string };
  /** 対戦中だけ。自分の視点の盤面 */
  view?: PlayerView;
  /** 自分の手番のときだけ入る */
  pending?: PendingRequest;
  result?: GameResultInfo;
  /** ロビーで選べるデッキ */
  presets?: { name: string; god: God; label: string }[];
  /** 直前の操作が弾かれた理由（部屋の状態は正しいまま） */
  error?: string;
}

export type ClientAction =
  | { t: 'create'; name: string; deck: DeckChoice; vsAi?: boolean; seed?: number }
  | { t: 'join'; room: string; name: string }
  | { t: 'deck'; room: string; seat: PlayerId; token: string; deck: DeckChoice }
  | { t: 'ready'; room: string; seat: PlayerId; token: string; ready: boolean }
  | { t: 'choose'; room: string; seat: PlayerId; token: string; index: number; answer: Answer }
  | { t: 'surrender'; room: string; seat: PlayerId; token: string };

/** ポーリングはこれだけを読む。**エンジンにも部屋の本体にも触らない** */
export interface VersionResponse {
  room: string;
  version: number | null;
}
