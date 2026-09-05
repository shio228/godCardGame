/**
 * Upstash Redis（REST）に部屋を置く。
 *
 * 依存を足さずに済むよう、SDK は使わず **REST を素の `fetch` で叩く**。
 * Vercel の Functions でも `node:http` のローカルサーバでも、そのまま動く。
 *
 * ## キーは2本だけ
 *
 * ```
 * room:<id>     部屋まるごと（StoredRoom の JSON）
 * room:<id>:v   版番号だけ         ← ポーリングはこれしか読まない
 * ```
 *
 * 版番号を別キーにしてあるのが要点で、**ポーリングは小さい文字列を1回読むだけ**で終わる。
 * 部屋の本体（盤面のビューを含むので数十KB）は、版が動いたときにしか読まない。
 *
 * ## 書き込みは1操作
 *
 * 「版が一致していたら、部屋と版を同時に書き換える」を Lua で1回にまとめてある。
 * 2人が同時に押しても、どちらか片方だけが通る。
 *
 * ## Postgres に移すとき
 *
 * 保存物は素のJSON、書き込みは `compareAndSet` の1操作しかないので、
 * `UPDATE rooms SET doc = $1, version = $2 WHERE id = $3 AND version = $4` に置き換わる。
 * `RoomStore` を実装した別のクラスを足すだけで、部屋のロジックは触らない。
 */
import type { RoomStore, StoredRoom } from './store';

/** 放置された部屋を溜めない。触るたびに延びる */
const TTL_SECONDS = 60 * 60 * 24;

/** 版が一致したときだけ、部屋と版を同時に書き換える */
const CAS_SCRIPT = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[4])
redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4])
return 1
`;

export interface RedisConfig {
  url: string;
  token: string;
}

export class RedisStoreError extends Error {}

export class RedisStore implements RoomStore {
  constructor(private readonly cfg: RedisConfig) {}

  async create(room: StoredRoom): Promise<void> {
    const id = room.doc.id;
    // NX にして、万一部屋コードがぶつかっても既存の部屋を潰さない
    const ok = await this.cmd<string | null>(['SET', docKey(id), JSON.stringify(room), 'NX', 'EX', String(TTL_SECONDS)]);
    if (ok === null) throw new RedisStoreError(`部屋コードが重複した: ${id}`);
    await this.cmd(['SET', verKey(id), String(room.doc.version), 'EX', String(TTL_SECONDS)]);
  }

  async get(id: string): Promise<StoredRoom | undefined> {
    const raw = await this.cmd<string | null>(['GET', docKey(id)]);
    if (raw === null) return undefined;
    return JSON.parse(raw) as StoredRoom;
  }

  async compareAndSet(id: string, expectedVersion: number, next: StoredRoom): Promise<boolean> {
    const res = await this.cmd<number>([
      'EVAL',
      CAS_SCRIPT,
      '2',
      docKey(id),
      verKey(id),
      String(expectedVersion),
      JSON.stringify(next),
      String(next.doc.version),
      String(TTL_SECONDS),
    ]);
    return res === 1;
  }

  /** ポーリングが呼ぶ唯一の経路。小さい文字列を1回読むだけ */
  async version(id: string): Promise<number | undefined> {
    const raw = await this.cmd<string | null>(['GET', verKey(id)]);
    return raw === null ? undefined : Number(raw);
  }

  private async cmd<T>(command: string[]): Promise<T> {
    const res = await fetch(this.cfg.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.cfg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(command),
    });
    if (!res.ok) {
      throw new RedisStoreError(`Redis が ${res.status} を返した: ${(await res.text()).slice(0, 200)}`);
    }
    const body = (await res.json()) as { result?: unknown; error?: string };
    if (body.error !== undefined) throw new RedisStoreError(`Redis: ${body.error}`);
    return body.result as T;
  }
}

function docKey(id: string): string {
  return `room:${id}`;
}

function verKey(id: string): string {
  return `room:${id}:v`;
}
