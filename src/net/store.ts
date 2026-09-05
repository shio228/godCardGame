/**
 * 部屋の保存。
 *
 * 保存するのは**素のJSON 1件**だけで、書き込みは
 * 「版が一致したときだけ書く」（`compareAndSet`）の1操作に閉じてある。
 * Redis なら1キー、Postgres なら1行の `jsonb` + `UPDATE … WHERE version = $1` に
 * そのまま乗るので、**保存先を差し替えるのは実装を1本足すだけ**で済む。
 *
 * 版番号だけは別に読めるようにしてある（`version`）。ポーリングはこれしか呼ばない。
 */
import type { PlayerId } from '../rules/types';
import type { PlayerView } from '../engine/view';
import type { GameResultInfo, PendingRequest, RoomStatus } from './protocol';
import type { GameSetup, RecordedChoice } from '../engine/replay';
import type { God } from '../rules/types';

export interface SeatDoc {
  name: string;
  /** 再接続に使う。クライアントは localStorage に持つ */
  token: string;
  ai: boolean;
  ready: boolean;
  god?: God;
  deckName?: string;
  /** 確定したデッキ（対戦開始時に `setup` へ移る） */
  cards?: string[];
  objectives?: string[];
}

export interface RoomDoc {
  id: string;
  version: number;
  status: RoomStatus;
  seats: Partial<Record<PlayerId, SeatDoc>>;
  vsAi: boolean;
  seed: number;
  /** 対戦開始時に確定。`setup` + `choices` が `GameRecord` そのものになる */
  setup?: GameSetup;
  choices: RecordedChoice[];
  createdAt: number;
  updatedAt: number;
}

/** 保存する1件。ビューは**作った完成品をそのまま持つ**（ポーリングで再生し直さないため） */
export interface StoredRoom {
  doc: RoomDoc;
  views: Partial<Record<PlayerId, PlayerView>>;
  pending?: PendingRequest;
  result?: GameResultInfo;
  /** 再生が落ちた場合の理由（エンジンの穴。部屋は止める） */
  error?: string;
}

export interface RoomStore {
  create(room: StoredRoom): Promise<void>;
  get(id: string): Promise<StoredRoom | undefined>;
  /** `expectedVersion` と一致したときだけ書く。書けたら true */
  compareAndSet(id: string, expectedVersion: number, next: StoredRoom): Promise<boolean>;
  /** **版番号だけ**読む。ポーリングが使う唯一の経路 */
  version(id: string): Promise<number | undefined>;
}

/** 開発とテスト用。プロセスが死ぬと消える */
export class MemoryStore implements RoomStore {
  private readonly rooms = new Map<string, StoredRoom>();

  async create(room: StoredRoom): Promise<void> {
    this.rooms.set(room.doc.id, structuredClone(room));
  }

  async get(id: string): Promise<StoredRoom | undefined> {
    const r = this.rooms.get(id);
    return r ? structuredClone(r) : undefined;
  }

  async compareAndSet(id: string, expectedVersion: number, next: StoredRoom): Promise<boolean> {
    const cur = this.rooms.get(id);
    if (!cur || cur.doc.version !== expectedVersion) return false;
    this.rooms.set(id, structuredClone(next));
    return true;
  }

  async version(id: string): Promise<number | undefined> {
    return this.rooms.get(id)?.doc.version;
  }

  /** テスト用 */
  get size(): number {
    return this.rooms.size;
  }
}
