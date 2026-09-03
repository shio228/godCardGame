/**
 * 特殊勝利条件（`ObjectiveDef`）の公開と評価。
 *
 * 企画書「基本システム / 基本ルール」より、本作の核になるルール:
 *   - 各神は固有の勝利条件を n 種持ち、その中から**最低3つ**を採用して伏せておく。
 *   - サイクルが1つ進むごとに、任意の順で**1つずつ公開**する（サイクル0から公開する）。
 *     公開されている条件だけが有効。
 *   - 各条件には**先行度**があり、1に近いほど先攻。そのサイクルの先攻後攻は
 *     「両者が最後に公開した条件」の先行度で決まる。
 *     手持ちを公開し尽くしたサイクル3以降は、最後の数値のまま固定される
 *     （＝「公開が起きない → 最後の値がそのまま残る」ので特別な分岐はいらない）。
 *   - 判定は ①サイクル開始フェイズ（公開）と ⑥終了フェイズ（参照）が基本だが、
 *     「n回目のダメージを与えたなら」のように途中で成立するものもあるため、
 *     エンジンは**誘発と状況起因の2経路**で評価する。
 *
 * 実装上、`ObjectiveDef.when` の形で2経路に分かれる:
 *
 *   when: TriggerEvent      … 通常の誘発とまったく同じ経路を通る。
 *                             events.ts の `gatherSources` が第5の発生源として拾う。
 *   when: {on:'continuous'} … 状況起因判定。`checkObjectives` が安全地点ごとに走査する。
 *                             `drainTriggers` の先頭から呼ばれるので、
 *                             既存の呼び出し地点（プレイ後・各項目の解決後・各フェイズ）を
 *                             すべて自動的に覆う。
 *
 * `effect` を省略した条件は「その条件の持ち主が勝利する」の意味になる。
 * 勝利以外の効果を持つ条件（創造の神）は `effect` を明示する。
 */
import type { Condition, Effect, Limit, ObjectiveDef, PlayerId, TriggerEvent } from '../rules/types';
import { Scope, logAction, type Ctx, type Engine } from './context';
import { evalCondition } from './condition';
import { RuleError } from './errors';
import { consumeLimit, emit, limitAvailable } from './events';

/** 「あなたは勝利する」— `effect` を省略した条件の既定の中身 */
const WIN_SELF: Effect = { t: 'win', player: { t: 'self' } };

/**
 * 状況起因の条件の既定の回数制限。
 *
 * continuous は「成立している間ずっと真」なので、制限がないと判定のたびに発火してしまう。
 * 勝利条件は一度達成すれば済むという読みで **1ゲームに1回** を既定にする。
 * 繰り返し発火させたい条件（創造の「1ターンに1度だけ」など）は `limit` を明示する。
 */
export const CONTINUOUS_DEFAULT_LIMIT: Limit = { count: 1, per: 'game' };

const PLAYERS: PlayerId[] = ['P1', 'P2'];

// ============================================================
// 形の判別
// ============================================================

export function isContinuousObjective(o: ObjectiveDef): boolean {
  return continuousWhen(o.when);
}

function continuousWhen(w: ObjectiveDef['when']): w is { on: 'continuous' } {
  return w.on === 'continuous';
}

/** limitUses のキー。誘発経路と状況起因経路で同じ枠を共有する */
export function objectiveLimitKey(player: PlayerId, id: string): string {
  return `objective:${player}:${id}`;
}

// ============================================================
// 採用（デッキ構築時）
// ============================================================

export interface SetupObjectivesOptions {
  /** 採用最低数。既定3（創造の神は企画上もっと多く選べるので呼び出し側で緩める） */
  min?: number;
}

/**
 * 採用した勝利条件を伏せた状態でセットする。
 * 「先行度は同じ数字を持たない」ルールをここで検査しておかないと、
 * 先攻決定が引き分けになって初めてデータの誤りに気づくことになる。
 */
export function setupObjectives(
  engine: Engine,
  player: PlayerId,
  ids: string[],
  opts: SetupObjectivesOptions = {},
): void {
  const min = opts.min ?? 3;
  if (ids.length < min) {
    throw new RuleError(`${player}: 特殊勝利条件は${min}つ以上採用しなければならない（${ids.length}つ）`);
  }
  const god = engine.state.players[player].god;
  const seen = new Set<number | 'special'>();
  for (const id of ids) {
    const o = engine.pool.objective(id);
    if (o.god !== god) throw new RuleError(`${o.name} は ${o.god} の勝利条件で、${player}（${god}）は採用できない`);
    // 'special' 枠は数値を持たないので重複検査の対象外
    if (o.initiative !== 'special') {
      if (seen.has(o.initiative)) throw new RuleError(`先行度 ${o.initiative} が重複している（${o.name}）`);
      seen.add(o.initiative);
    }
  }
  engine.state.players[player].objectives = [...ids];
  engine.state.players[player].revealedObjectives = [];
}

// ============================================================
// 公開
// ============================================================

/** 伏せてある条件の定義一覧 */
export function hiddenObjectives(engine: Engine, player: PlayerId): ObjectiveDef[] {
  return engine.state.players[player].objectives.map((id) => engine.pool.objective(id));
}

/** 公開済みの条件の定義一覧（公開順） */
export function revealedObjectives(engine: Engine, player: PlayerId): ObjectiveDef[] {
  return engine.state.players[player].revealedObjectives.map((id) => engine.pool.objective(id));
}

/** 両プレイヤーの公開済み条件を、持ち主つきで列挙する */
export function eachRevealedObjective(engine: Engine): { objective: ObjectiveDef; controller: PlayerId }[] {
  const out: { objective: ObjectiveDef; controller: PlayerId }[] = [];
  for (const pid of PLAYERS) {
    for (const o of revealedObjectives(engine, pid)) out.push({ objective: o, controller: pid });
  }
  return out;
}

/**
 * 伏せてある条件を1つ公開状態にする（イベントは出さない）。
 * カード効果 `revealObjective` と、サイクル開始の公開の共通処理。
 */
export function revealObjectiveById(engine: Engine, player: PlayerId, id: string): ObjectiveDef {
  const p = engine.state.players[player];
  const i = p.objectives.indexOf(id);
  if (i < 0) throw new RuleError(`${player} は ${id} を伏せて持っていない`);
  p.objectives.splice(i, 1);
  p.revealedObjectives.push(id);
  return engine.pool.objective(id);
}

/** インデックス指定版（`revealObjective` の `which` 用） */
export function revealObjectiveAt(engine: Engine, player: PlayerId, index: number): ObjectiveDef | undefined {
  const id = engine.state.players[player].objectives[index];
  if (id === undefined) return undefined;
  return revealObjectiveById(engine, player, id);
}

export function objectiveCtx(engine: Engine, player: PlayerId): Ctx {
  return { engine, self: player, vars: new Scope() };
}

/** 公開されたことを誘発できるようにする（「勝利条件が公開されたとき」） */
export async function emitObjectiveRevealed(engine: Engine, player: PlayerId, id: string): Promise<void> {
  await emit(objectiveCtx(engine, player), { kind: 'objectiveRevealed', player, objectiveId: id });
}

/**
 * ①サイクル開始フェイズの公開。
 *
 * 両者の選択を**先に集めてからまとめて公開する**。1つずつ公開すると、
 * 後に選ぶ側が相手の先行度を見てから決められてしまい、
 * 「カードを見せあって先攻後攻を決める」というルールにならない。
 */
export async function revealPhase(engine: Engine): Promise<void> {
  const picks: { player: PlayerId; id: string }[] = [];

  for (const pid of PLAYERS) {
    const hidden = hiddenObjectives(engine, pid);
    if (hidden.length === 0) continue; // 公開し尽くしている → 最後に公開した条件のまま
    const [id] = await engine.chooser.select<string>({
      kind: 'objective',
      player: pid,
      prompt: 'このサイクルに公開する特殊勝利条件を選ぶ',
      options: hidden.map((o) => ({ value: o.id, label: `${o.name}（先行度${o.initiative}）` })),
      min: 1,
      max: 1,
    });
    if (id !== undefined) picks.push({ player: pid, id });
  }

  for (const pick of picks) {
    const o = revealObjectiveById(engine, pick.player, pick.id);
    logAction(engine, 'reveal', `${pick.player} が勝利条件を公開: ${o.name}（先行度${o.initiative}）`, pick.player);
  }

  determineFirst(engine);

  for (const pick of picks) await emitObjectiveRevealed(engine, pick.player, pick.id);
}

// ============================================================
// 先攻決定
// ============================================================

/**
 * 「最後に公開した条件」の先行度で先攻を決める。1に近いほど先攻。
 *
 * `initiative: 'special'` は数値が割り当てられていない創造の神の特殊枠。
 * 数値と比較できないので**最後尾**として扱い、'special' 同士なら前サイクルの
 * 先攻を維持する（企画側で数値が決まったらここは不要になる）。
 */
export function determineFirst(engine: Engine): void {
  const a = lastInitiative(engine, 'P1');
  const b = lastInitiative(engine, 'P2');
  if (a === undefined || b === undefined) return; // どちらかが未公開なら現状維持
  if (a === b) {
    // 「先行度は同じ数字を持たない」— 数値で並んだらデータの誤り
    if (Number.isFinite(a)) throw new RuleError(`先行度 ${a} が両者で重複している。先行度は一意でなければならない`);
    return; // 'special' 同士 → 現状維持
  }
  engine.state.first = a < b ? 'P1' : 'P2';
}

function lastInitiative(engine: Engine, player: PlayerId): number | undefined {
  const ids = engine.state.players[player].revealedObjectives;
  const last = ids[ids.length - 1];
  if (last === undefined) return undefined;
  const init = engine.pool.objective(last).initiative;
  return init === 'special' ? Number.POSITIVE_INFINITY : init;
}

// ============================================================
// 誘発経路（events.ts が使う）
// ============================================================

export interface ObjectiveTrigger {
  objective: ObjectiveDef;
  controller: PlayerId;
  when: TriggerEvent;
  effect: Effect;
  limit?: Limit;
  key: string;
  origin: string;
}

/**
 * 公開済みの「誘発型」条件を、誘発の発生源として使える形にして返す。
 * `ObjectiveDef.cond` は `TriggerEvent.cond` に合流させる（両方あれば and）。
 */
export function objectiveTriggers(engine: Engine): ObjectiveTrigger[] {
  const out: ObjectiveTrigger[] = [];
  for (const { objective: o, controller } of eachRevealedObjective(engine)) {
    if (continuousWhen(o.when)) continue;
    const when: TriggerEvent = { ...o.when };
    const merged = mergeCond(o.when.cond, o.cond);
    if (merged) when.cond = merged;
    const t: ObjectiveTrigger = {
      objective: o,
      controller,
      when,
      effect: o.effect ?? WIN_SELF,
      key: objectiveLimitKey(controller, o.id),
      origin: `勝利条件:${o.name}`,
    };
    if (o.limit) t.limit = o.limit;
    out.push(t);
  }
  return out;
}

function mergeCond(a: Condition | undefined, b: Condition | undefined): Condition | undefined {
  if (a && b) return { t: 'and', of: [a, b] };
  return a ?? b;
}

// ============================================================
// 状況起因の評価ループ
// ============================================================

/**
 * 公開済みの「状況起因型」条件をすべて走査し、成立しているものを実行する。
 *
 * 呼び出し地点は `drainTriggers` の先頭に1つだけ置いてある。
 * プレイ後・スタック項目の解決後・各フェイズはすべて `drainTriggers` を通るので、
 * 判定漏れが起きる場所を作らずに済む。
 *
 * 走査順は先攻 → 後攻。同一プレイヤー内は公開順。
 * 勝利が確定した時点で残りは評価しない。
 */
export async function checkObjectives(engine: Engine): Promise<void> {
  const s = engine.state;
  if (s.winner) return;

  const order: PlayerId[] = [s.first, s.first === 'P1' ? 'P2' : 'P1'];
  for (const pid of order) {
    for (const o of revealedObjectives(engine, pid)) {
      if (!continuousWhen(o.when)) continue;

      const limit = o.limit ?? CONTINUOUS_DEFAULT_LIMIT;
      const key = objectiveLimitKey(pid, o.id);
      if (!limitAvailable(engine, key, limit)) continue;

      const ctx = objectiveCtx(engine, pid);
      if (o.cond && !(await evalCondition(o.cond, ctx))) continue;

      consumeLimit(engine, key, limit);
      logAction(engine, 'win', `勝利条件 達成: ${o.name}（${pid}）`, pid);

      const { resolve } = await import('./effects');
      await resolve(o.effect ?? WIN_SELF, ctx);
      if (s.winner) {
        if (s.winReason === '効果') s.winReason = `勝利条件:${o.name}`;
        return;
      }
    }
  }
}
