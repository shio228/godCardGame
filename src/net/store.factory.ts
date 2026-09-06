/**
 * 環境変数から保存先を決める。
 *
 * **エンジンを import しない。** ポーリングの経路（`server/functions/v.ts`）はここまでしか辿らないので、
 * この一線を守っている限り、版番号を返すだけの呼び出しにカードもルールも載らない
 * （`src/net/routes.test.ts` が構造として見張る）。
 */
import { MemoryStore } from './store';
import { RedisStore } from './store.redis';
import type { RoomStore } from './store';

export class StoreConfigError extends Error {}

export interface StoreEnv {
  UPSTASH_REDIS_REST_URL?: string | undefined;
  UPSTASH_REDIS_REST_TOKEN?: string | undefined;
  /** Vercel が自動で入れる。ここでは「常駐しない環境かどうか」の判定に使う */
  VERCEL?: string | undefined;
}

let memory: MemoryStore | undefined;

export function storeFromEnv(env: StoreEnv = process.env): RoomStore {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (url !== undefined && url !== '' && token !== undefined && token !== '') {
    return new RedisStore({ url, token });
  }
  if (env.VERCEL !== undefined && env.VERCEL !== '') {
    // 黙ってメモリに落とすと「部屋が作れるのに次の呼び出しで消える」という
    // いちばん分かりにくい壊れ方をする。ここで止める
    throw new StoreConfigError(
      'UPSTASH_REDIS_REST_URL と UPSTASH_REDIS_REST_TOKEN が要る（Vercel では呼び出しをまたいで覚えていられないため）',
    );
  }
  // ローカル開発。プロセスが死ぬと部屋も消える
  memory ??= new MemoryStore();
  return memory;
}
