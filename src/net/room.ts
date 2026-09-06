/**
 * 部屋の中身。**ソケットもHTTPも知らない。**
 *
 * 保存は `RoomStore` 越し、エンジンは `resumeGame` 越しにしか触らない。
 * おかげでテストはメモリ上の保存先だけで1試合を最後まで通せる。
 *
 * ## エンジンを回す場所はここだけ
 *
 * `advance()` が唯一の入口で、呼ばれるのは**選択が入ったとき**と
 * **対戦が始まるとき**だけ。ポーリング（`version` / `snapshot`）からは呼ばない。
 *
 * ## 割り込みの扱い
 *
 * 応答には「何手目か」（`index`）を添えてもらい、
 * **`index === choices.length` のときだけ適用する**。二重送信も、遅れて届いた古い応答も、
 * これだけで弾ける（ロックも取らない）。
 */
import type { CardPool, God, PlayerId } from '../rules/types';
import { GreedyChooser } from '../engine/ai';
import { RandomChooser } from '../engine/chooser';
import { parseDeckList, type ParsedDeck } from '../engine/decklist';
import { PoolIndex } from '../engine/pool';
import type { GameSetup } from '../engine/replay';
import { DECK_TEXTS, PRESET_NAMES } from '../rules/decks.generated';
import type { ClientAction, DeckChoice, RoomSnapshot, SeatInfo } from './protocol';
import { answerToChoice, askChooser, resumeGame } from './resume';
import type { RoomDoc, RoomStore, SeatDoc, StoredRoom } from './store';

const SEATS: PlayerId[] = ['P1', 'P2'];
/** AI が続けて答えられる上限（暴走よけ） */
const AI_STEPS = 400;

export class RoomError extends Error {}

// ============================================================
// ちいさな道具
// ============================================================

function randomInt(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0]!;
}

/** 読み上げやすい部屋コード（紛らわしい文字を外す） */
export function newRoomId(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return [...a].map((n) => alphabet[n % alphabet.length]).join('');
}

function newToken(): string {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return [...a].map((n) => n.toString(16).padStart(2, '0')).join('');
}

// ============================================================
// デッキ
// ============================================================

export function presetList(pool: PoolIndex): { name: string; god: God; label: string }[] {
  return PRESET_NAMES.map((name) => {
    const deck = parseDeckList(DECK_TEXTS[name]!, pool, { name });
    return { name, god: deck.god, label: deck.name };
  });
}

/** 貼り付けたテキストもプリセットも、同じパーサを通す（CLI と判定がずれない） */
export function resolveDeck(pool: PoolIndex, choice: DeckChoice): ParsedDeck {
  const text = 'preset' in choice ? DECK_TEXTS[choice.preset] : choice.text;
  if (text === undefined) throw new RoomError(`そのデッキは無い: ${JSON.stringify(choice)}`);
  return parseDeckList(text, pool, { name: 'preset' in choice ? choice.preset : 'デッキ' });
}

// ============================================================
// 部屋
// ============================================================

export interface RoomServiceOptions {
  pool: CardPool;
  store: RoomStore;
  /** AI の席の打ち手を差し替える（テスト用） */
  aiSeed?: number;
  /**
   * 再生の実装を差し替える口。
   * 費用の要は「エンジンを回すのが選択のときだけ」なので、
   * **回数を数えられるようにしてある**（`src/net/cost.test.ts`）。
   */
  resume?: typeof resumeGame;
}

export class RoomService {
  private readonly index: PoolIndex;

  constructor(private readonly opts: RoomServiceOptions) {
    this.index = new PoolIndex(opts.pool);
  }

  /** ポーリングが使う唯一の経路。**エンジンにも部屋の本体にも触らない** */
  version(room: string): Promise<number | undefined> {
    return this.opts.store.version(room);
  }

  /** 保存済みのビューを返すだけ。ここでもエンジンは回さない */
  async snapshot(room: string, seat?: PlayerId, token?: string): Promise<RoomSnapshot> {
    const stored = await this.load(room);
    const ok = seat !== undefined && stored.doc.seats[seat]?.token === token;
    return this.toSnapshot(stored, ok ? seat : undefined);
  }

  async handle(action: ClientAction): Promise<RoomSnapshot> {
    switch (action.t) {
      case 'create':
        return this.create(action);
      case 'join':
        return this.join(action);
      default:
        return this.mutate(action);
    }
  }

  // ----------------------------------------------------------

  private async load(id: string): Promise<StoredRoom> {
    const stored = await this.opts.store.get(id);
    if (!stored) throw new RoomError(`部屋が見つからない: ${id}`);
    return stored;
  }

  private async create(a: Extract<ClientAction, { t: 'create' }>): Promise<RoomSnapshot> {
    const deck = resolveDeck(this.index, a.deck);
    const token = newToken();
    const doc: RoomDoc = {
      id: newRoomId(),
      version: 1,
      status: 'lobby',
      seats: { P1: seatOf(a.name, token, deck) },
      vsAi: a.vsAi === true,
      seed: a.seed ?? randomInt(),
      choices: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (doc.vsAi) doc.seats.P2 = aiSeat(this.index, deck.god, a.aiDeck);

    const stored: StoredRoom = { doc, views: {} };
    // AI 相手なら席がもう揃っている。作った時点で始める（待つ相手がいない）
    if (this.readyToStart(doc)) {
      this.begin(doc);
      await this.advance(stored);
    }
    await this.opts.store.create(stored);
    const snap = this.toSnapshot(stored, 'P1');
    snap.you = { seat: 'P1', token };
    return snap;
  }

  private async join(a: Extract<ClientAction, { t: 'join' }>): Promise<RoomSnapshot> {
    return this.write(a.room, (stored) => {
      const free = SEATS.find((s) => !stored.doc.seats[s]);
      if (!free) throw new RoomError('この部屋はもう埋まっている');
      const token = newToken();
      stored.doc.seats[free] = { name: a.name, token, ai: false, ready: false };
      return { seat: free, token };
    });
  }

  private async mutate(
    a: Extract<ClientAction, { t: 'deck' | 'ready' | 'choose' | 'surrender' }>,
  ): Promise<RoomSnapshot> {
    return this.write(a.room, async (stored) => {
      const seat = stored.doc.seats[a.seat];
      if (!seat || seat.token !== a.token) throw new RoomError('その席の権限がない');

      switch (a.t) {
        case 'deck': {
          if (stored.doc.status !== 'lobby') throw new RoomError('対戦が始まっているので変えられない');
          const deck = resolveDeck(this.index, a.deck);
          const foe = stored.doc.seats[other(a.seat)];
          // 同神対決はルール上起こらない（両者が同じ勝利条件を公開しうると先行度が並ぶ）
          if (foe?.god === deck.god) {
            throw new RoomError(`相手も${deck.god}です。同じ神同士は対戦できません（先行度が並ぶため）`);
          }
          Object.assign(seat, deckFields(deck));
          seat.ready = false;
          break;
        }
        case 'ready': {
          if (stored.doc.status !== 'lobby') break;
          if (a.ready && !seat.cards) throw new RoomError('先にデッキを選ぶ');
          seat.ready = a.ready;
          break;
        }
        case 'surrender': {
          if (stored.doc.status !== 'playing') break;
          // 投了は「降伏の選択」ではなく記録の外側で決める（エンジンの `surrender` と同じ結果）
          stored.result = { winner: other(a.seat), reason: '降伏', cycles: stored.views[a.seat]?.cycle ?? 0 };
          stored.doc.status = 'over';
          delete stored.pending;
          break;
        }
        case 'choose': {
          if (stored.doc.status !== 'playing') throw new RoomError('対戦中ではない');
          // 手数の判定を先に置く。再送や遅れて届いた応答は、
          // そのあいだに手番が移っていても「古い応答」として素通しにしたい
          if (a.index !== stored.doc.choices.length) return { note: 'stale', seat: a.seat };
          const pending = stored.pending;
          if (!pending) throw new RoomError('いま選ぶものは無い');
          if (pending.player !== a.seat) throw new RoomError('相手の手番です');
          stored.doc.choices.push(answerToChoice(pending, a.answer));
          break;
        }
      }

      if (stored.doc.status === 'lobby' && this.readyToStart(stored.doc)) this.begin(stored.doc);
      if (stored.doc.status === 'playing') await this.advance(stored);
      return { seat: a.seat };
    });
  }

  /** 版を見て書き込む。競合したら1度だけやり直す */
  private async write(
    id: string,
    fn: (stored: StoredRoom) => Promise<{ seat?: PlayerId; token?: string; note?: string }> | { seat?: PlayerId; token?: string; note?: string },
  ): Promise<RoomSnapshot> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const stored = await this.load(id);
      const before = stored.doc.version;
      const info = await fn(stored);
      if (info.note === 'stale') return this.toSnapshot(stored, info.seat);

      stored.doc.version = before + 1;
      stored.doc.updatedAt = Date.now();
      if (await this.opts.store.compareAndSet(id, before, stored)) {
        const snap = this.toSnapshot(stored, info.seat);
        if (info.seat && info.token) snap.you = { seat: info.seat, token: info.token };
        return snap;
      }
    }
    throw new RoomError('同時に更新されました。もう一度お試しください');
  }

  private readyToStart(doc: RoomDoc): boolean {
    return SEATS.every((s) => {
      const seat = doc.seats[s];
      return seat !== undefined && seat.cards !== undefined && (seat.ai || seat.ready);
    });
  }

  private begin(doc: RoomDoc): void {
    const p1 = doc.seats.P1!;
    const p2 = doc.seats.P2!;
    const setup: GameSetup = {
      p1God: p1.god!,
      p2God: p2.god!,
      decks: {
        P1: { cards: p1.cards!, objectives: p1.objectives! },
        P2: { cards: p2.cards!, objectives: p2.objectives! },
      },
      seed: doc.seed,
    };
    doc.setup = setup;
    doc.status = 'playing';
    doc.choices = [];
  }

  /**
   * 記録を再生して、次の選択とビューを作る。
   * 次の選択が AI の席なら、その場で答えさせて記録に足し、また再生する。
   */
  private async advance(stored: StoredRoom): Promise<void> {
    const doc = stored.doc;
    const setup = doc.setup;
    if (!setup) throw new RoomError('対戦が始まっていない');
    const names = {
      P1: doc.seats.P1?.name ?? 'P1',
      P2: doc.seats.P2?.name ?? 'P2',
    };

    for (let step = 0; step < AI_STEPS; step++) {
      const res = await (this.opts.resume ?? resumeGame)(this.opts.pool, setup, doc.choices, { names });
      stored.views = res.views;
      if (res.error !== undefined) {
        stored.error = res.error;
        stored.doc.status = 'over';
        delete stored.pending;
        return;
      }
      if (res.result) {
        stored.result = res.result;
        stored.doc.status = 'over';
        delete stored.pending;
        return;
      }
      if (!res.pending || !res.raw) {
        delete stored.pending;
        return;
      }

      const seat = doc.seats[res.pending.player];
      if (!seat?.ai) {
        stored.pending = res.pending;
        return; // 人の番。ここで止めて応答を待つ
      }

      // AI の席。いま止まっているエンジンで答えさせて記録に足す
      const ai = new GreedyChooser({ fallback: new RandomChooser(this.opts.aiSeed ?? doc.seed) });
      ai.attach(res.engine);
      doc.choices.push(await askChooser(ai, res.raw));
    }
    throw new RoomError('AI の手番が終わらない');
  }

  private toSnapshot(stored: StoredRoom, seat?: PlayerId): RoomSnapshot {
    const doc = stored.doc;
    const snap: RoomSnapshot = {
      room: doc.id,
      version: doc.version,
      status: doc.status,
      vsAi: doc.vsAi,
      seats: SEATS.filter((s) => doc.seats[s]).map((s) => seatInfo(s, doc.seats[s]!)),
    };
    if (doc.status === 'lobby') snap.presets = presetList(this.index);
    if (seat) {
      const view = stored.views[seat];
      if (view) snap.view = view;
      if (stored.pending && stored.pending.player === seat) snap.pending = stored.pending;
    }
    if (stored.result) snap.result = stored.result;
    if (stored.error !== undefined) snap.error = stored.error;
    return snap;
  }
}

// ============================================================

function seatInfo(seat: PlayerId, s: SeatDoc): SeatInfo {
  return {
    seat,
    name: s.name,
    ai: s.ai,
    ready: s.ready,
    ...(s.god !== undefined ? { god: s.god } : {}),
    ...(s.deckName !== undefined ? { deckName: s.deckName } : {}),
  };
}

function deckFields(deck: ParsedDeck): Pick<SeatDoc, 'god' | 'deckName' | 'cards' | 'objectives'> {
  return { god: deck.god, deckName: deck.name, cards: deck.cards, objectives: deck.objectives };
}

function seatOf(name: string, token: string, deck: ParsedDeck): SeatDoc {
  return { name, token, ai: false, ready: true, ...deckFields(deck) };
}

/** AI の席。**相手と違う神**を選ぶ（同神対決はルール上起こらない） */
function aiSeat(pool: PoolIndex, avoid: God, choice?: DeckChoice): SeatDoc {
  const seat = (deck: ParsedDeck): SeatDoc => ({
    name: `AI（${deck.name}）`,
    token: newToken(),
    ai: true,
    ready: true,
    ...deckFields(deck),
  });

  if (choice) {
    const deck = resolveDeck(pool, choice);
    // 同神対決はルール上起こらないので、指定されても断る
    if (deck.god === avoid) throw new RoomError(`AI にも ${avoid} は選べません（同じ神同士は対戦できない）`);
    return seat(deck);
  }

  // 指定が無ければ**毎回ランダム**。先頭固定だと相手の神がいつも同じになる
  const usable = PRESET_NAMES.map((name) => parseDeckList(DECK_TEXTS[name]!, pool, { name })).filter(
    (d) => d.god !== avoid,
  );
  const pick = usable[randomInt() % usable.length];
  if (!pick) throw new RoomError(`${avoid} 以外のデッキが無い`);
  return seat(pick);
}

function other(seat: PlayerId): PlayerId {
  return seat === 'P1' ? 'P2' : 'P1';
}
