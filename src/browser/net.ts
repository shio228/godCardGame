/**
 * サーバとのやりとり。**画面はゲームの状態を持たない。**
 *
 * 持っているのは「サーバから受け取った最後の盤面」だけで、
 * 選択を送るとその応答に新しい盤面が入って返ってくる。
 * ずれようがない代わりに、相手の手番のあいだは問い合わせに行く必要がある。
 *
 * ## 問い合わせを減らす（費用がかかるのはサーバ側なので）
 *
 * - **自分の手番のあいだは行かない**（待っているのはこちらではなくサーバ）
 * - 相手の手番になってから 1秒 → 3秒 → 5秒と間隔を広げる
 * - **タブが隠れているあいだは止める**。表に戻った瞬間に1回だけ行く
 * - 行き先は**版番号を返すだけの経路**。番号が変わったときにだけ盤面を取りにいく
 */
import type { Answer, ClientAction, DeckChoice, RoomSnapshot, VersionResponse } from '../net/protocol';
import type { PlayerId } from '../rules/types';

/** 席の身分証。これがあれば同じ席に戻れる */
export interface Session {
  room: string;
  seat: PlayerId;
  token: string;
}

/**
 * 席の控えは**タブごと**に持つ。
 *
 * いま座っている席は **sessionStorage**（タブごと・リロードでは残る）。
 * これで同じブラウザの2つのタブが別々の席に座れる——手元で2人ぶんを動かすときに要る。
 * （部屋コードで引く表を localStorage に1つ置く作りだと、
 *   同じ部屋の2席目が1席目の身分証を上書きしてしまう。）
 *
 * タブを閉じても戻れるように、控えは localStorage にも `部屋:席` の鍵で残す。
 * ただし**勝手に座り直さない**——入口に「戻る」ボタンとして並べるだけにする。
 */
const RECENT = 'cardgame.seats';
const CURRENT = 'cardgame.session';
/** 覚えておく席の数 */
const RECENT_MAX = 4;

export function loadSession(): Session | undefined {
  try {
    const raw = sessionStorage.getItem(CURRENT);
    if (raw === null) return undefined;
    const s = JSON.parse(raw) as Session;
    return typeof s.room === 'string' && typeof s.token === 'string' ? s : undefined;
  } catch {
    return undefined; // 個人用の便利機能なので、読めなければ無かったことにする
  }
}

/** 最近すわった席（新しい順）。入口に「戻る」ボタンとして出す */
export function recentSeats(): Session[] {
  try {
    const raw = localStorage.getItem(RECENT);
    const list = raw === null ? [] : (JSON.parse(raw) as Session[]);
    return Array.isArray(list) ? list.filter((s) => typeof s?.room === 'string' && typeof s?.token === 'string') : [];
  } catch {
    return [];
  }
}

export function saveSession(s: Session | undefined): void {
  try {
    if (!s) {
      sessionStorage.removeItem(CURRENT);
      return;
    }
    sessionStorage.setItem(CURRENT, JSON.stringify(s));
    const rest = recentSeats().filter((x) => !(x.room === s.room && x.seat === s.seat));
    localStorage.setItem(RECENT, JSON.stringify([s, ...rest].slice(0, RECENT_MAX)));
  } catch {
    // 保存できなくても遊べる（リロードで戻れなくなるだけ）
  }
}

export function forgetSeat(s: Session): void {
  try {
    localStorage.setItem(
      RECENT,
      JSON.stringify(recentSeats().filter((x) => !(x.room === s.room && x.seat === s.seat))),
    );
  } catch {
    // 消せなくても実害はない
  }
}

export class ApiError extends Error {}

async function post(action: ClientAction): Promise<RoomSnapshot> {
  const res = await fetch('/api/game', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(action),
  });
  const body = (await res.json()) as RoomSnapshot & { error?: string };
  if (!res.ok) throw new ApiError(body.error ?? `サーバが ${res.status} を返しました`);
  return body;
}

export const api = {
  create: (name: string, deck: DeckChoice, vsAi: boolean): Promise<RoomSnapshot> =>
    post({ t: 'create', name, deck, vsAi }),

  join: (room: string, name: string): Promise<RoomSnapshot> => post({ t: 'join', room, name }),

  deck: (s: Session, deck: DeckChoice): Promise<RoomSnapshot> => post({ t: 'deck', ...s, deck }),

  ready: (s: Session, ready: boolean): Promise<RoomSnapshot> => post({ t: 'ready', ...s, ready }),

  choose: (s: Session, index: number, answer: Answer): Promise<RoomSnapshot> =>
    post({ t: 'choose', ...s, index, answer }),

  surrender: (s: Session): Promise<RoomSnapshot> => post({ t: 'surrender', ...s }),

  /** 版番号だけ。ポーリングはこれしか呼ばない */
  async version(room: string): Promise<number | null> {
    const res = await fetch(`/api/v?room=${encodeURIComponent(room)}`);
    if (!res.ok) throw new ApiError(`サーバが ${res.status} を返しました`);
    return ((await res.json()) as VersionResponse).version;
  },

  async state(s: Session): Promise<RoomSnapshot> {
    const q = `room=${encodeURIComponent(s.room)}&seat=${s.seat}&token=${encodeURIComponent(s.token)}`;
    const res = await fetch(`/api/state?${q}`);
    const body = (await res.json()) as RoomSnapshot & { error?: string };
    if (!res.ok) throw new ApiError(body.error ?? `サーバが ${res.status} を返しました`);
    return body;
  },
};

/** 相手を待つあいだの間隔（ミリ秒）。だんだん広げる */
export const POLL_STEPS = [1000, 1000, 3000, 3000, 5000];

/**
 * 自分の手番のあいだの間隔。
 *
 * 手番中は待つものが無いので本来は要らないが、**完全に止めてはいけない**。
 * 選択を送った応答が届かないまま切れると、こちらは「まだ自分の手番」のつもりで固まり、
 * サーバは先に進んでいる、という噛み合わない状態のまま復帰できなくなる
 * （別の端末から同じ席で打った場合も同じ）。
 * 版番号を見に行くだけなら安いので、ゆっくり心音だけ打つ。
 */
export const SELF_TURN_MS = 15000;

export function pollDelay(round: number, myTurn = false): number {
  if (myTurn) return SELF_TURN_MS;
  return POLL_STEPS[Math.min(round, POLL_STEPS.length - 1)]!;
}

/**
 * 問い合わせに行くべきか。
 * **決着後とタブが隠れているあいだは行かない。**
 */
export function shouldPoll(snap: RoomSnapshot | undefined, hidden: boolean): boolean {
  if (!snap || hidden) return false;
  return snap.status !== 'over';
}

/** 自分の手番か（間隔を決めるのに使う） */
export function isMyTurn(snap: RoomSnapshot | undefined): boolean {
  return snap?.status === 'playing' && snap.pending !== undefined;
}
