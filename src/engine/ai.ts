/**
 * 目的志向の打ち手（`GreedyChooser`）。
 *
 * `RandomChooser` が一様ランダムに選ぶのに対し、こちらは**2つの選択だけを考える**:
 *
 *   ① サイクル開始の公開 — いちばん達成に近い勝利条件を公開する
 *   ② スタックフェイズのプレイ — 候補ごとに盤面を複製して試し、いちばん得な手を選ぶ
 *
 * それ以外（どのカードを捨てるか、誘発の順、対象の選択…）は `AutoChooser` に委ねる。
 * 全部を賢くするのが目的ではなく、**「特殊勝利を狙う打ち手」を作って
 * ランダムとの差を数字で見る**のが目的なので、効く2か所に絞っている。
 *
 * ## なぜ「1手先読み」ではなく「そのカードを試し解決する」のか
 *
 * このゲームはプレイしてもカードはスタックに乗るだけで、効果は解決フェイズまで起きない。
 * 「1手指して盤面を見る」式の先読みはほとんど何も見えない（動くのは onPlay と
 * 炎天・豪雨くらい）。そこで**複製した盤面でそのカードを最後まで解決してから測る**。
 * スタックの絡み（相手に上から乗せられる・打ち消される）は無視するが、
 * カード単体の働きは正しく測れる。
 *
 * ## 測っているもの
 *
 *   相手のライフの減り  +1.0 / 点
 *   自分のライフの増減  +selfLifeWeight / 点
 *   勝利条件の進捗      +objectiveWeight / (0〜1の達成度の合計)
 *   勝敗が決まるなら    ±1000
 *
 * 進捗は `progress.ts` が勝利条件のデータ（`cond`）から直接計算する。
 * AI 側に「詠唱を貯めろ」「ミニオンを並べろ」といった知識は一切書いていない。
 */
import type { PlayerId } from '../rules/types';
import {
  AutoChooser,
  type Chooser,
  type ConfirmRequest,
  type NumberRequest,
  type OrderRequest,
  type SelectRequest,
} from './chooser';
import type { Engine } from './context';
import { resolveStackItem } from './effects';
import { drainTriggers } from './events';
import {
  PLAY_PROMPT,
  isPlayChoice,
  performAlternativePlay,
  play,
  playChoices,
  topCtx,
  type PlayChoice,
} from './flow';
import { hiddenObjectives, revealedObjectives } from './objectives';
import { objectiveScore } from './progress';
import { opponentOf, snapshot } from './state';

export interface GreedyOptions {
  /** 勝利条件の進捗1.0ぶんを、相手ライフ何点ぶんと見るか */
  objectiveWeight?: number;
  /** 自分のライフ1点の重み（負の値ほど自分の消耗を嫌う） */
  selfLifeWeight?: number;
  /** 伏せてある勝利条件の進捗をどれだけ見るか（0〜1） */
  hiddenWeight?: number;
  /** これを下回る手しか無ければパスする */
  passThreshold?: number;
  /** 1回の判断で試す候補の上限（先頭から。手札が多いときの打ち切り） */
  maxCandidates?: number;
  /** 試し解決の中で使う打ち手（既定 AutoChooser）と、考えない選択の委譲先 */
  fallback?: Chooser;
  /** 試し解決に使う予算（無限ループ検出） */
  budget?: number;
}

interface Measured {
  selfLife: number;
  oppLife: number;
  objective: number;
}

export class GreedyChooser implements Chooser {
  private readonly objectiveWeight: number;
  private readonly selfLifeWeight: number;
  private readonly hiddenWeight: number;
  private readonly passThreshold: number;
  private readonly maxCandidates: number;
  private readonly budget: number;
  private readonly fallback: Chooser;

  constructor(opts: GreedyOptions = {}) {
    this.objectiveWeight = opts.objectiveWeight ?? 30;
    this.selfLifeWeight = opts.selfLifeWeight ?? 0.5;
    this.hiddenWeight = opts.hiddenWeight ?? 0.5;
    this.passThreshold = opts.passThreshold ?? 0;
    this.maxCandidates = opts.maxCandidates ?? 12;
    this.budget = opts.budget ?? 3000;
    this.fallback = opts.fallback ?? new AutoChooser();
  }

  /**
   * 考えるのはこの2つだけ。engine を必要とするので、
   * `Engine` を後から差してもらう（`createEngine` のあとに `attach`）。
   */
  private engine?: Engine;

  attach(engine: Engine): this {
    this.engine = engine;
    return this;
  }

  async select<T>(req: SelectRequest<T>): Promise<T[]> {
    const engine = this.engine;
    if (!engine) return this.fallback.select(req);

    if (req.prompt === PLAY_PROMPT) {
      const picked = await this.choosePlay(engine, req);
      if (picked) return picked;
      return [];
    }
    if (req.kind === 'objective') {
      const picked = await this.chooseObjective(engine, req);
      if (picked) return picked;
    }
    return this.fallback.select(req);
  }

  async number(req: NumberRequest): Promise<number> {
    return this.fallback.number(req);
  }

  async confirm(req: ConfirmRequest): Promise<boolean> {
    return this.fallback.confirm(req);
  }

  async order<T>(req: OrderRequest<T>): Promise<T[]> {
    return this.fallback.order(req);
  }

  // ----------------------------------------------------------
  // ① 公開する勝利条件を選ぶ
  // ----------------------------------------------------------

  /**
   * いちばん達成に近い条件を公開する。
   * 同じくらいなら**先行度の小さい方**（＝先攻を取る）を選ぶ。
   */
  private async chooseObjective<T>(engine: Engine, req: SelectRequest<T>): Promise<T[] | undefined> {
    const { objectiveProgress } = await import('./progress');
    const progress = await objectiveProgress(engine, req.player);
    const byId = new Map(progress.map((p) => [p.objective.id, p]));

    let best: { value: T; score: number } | undefined;
    for (const o of req.options) {
      const id = typeof o.value === 'string' ? o.value : undefined;
      if (id === undefined) return undefined; // 想定外の形（勝利条件の選択は id 文字列）
      const p = byId.get(id);
      if (!p) return undefined;
      const init = p.objective.initiative;
      // 先行度は 1 に近いほど先攻。小さいほどわずかに加点する
      const initBonus = typeof init === 'number' ? (16 - init) / 16 : 0;
      const score = (p.progress ?? 0) * 10 + initBonus;
      if (!best || score > best.score) best = { value: o.value, score };
    }
    return best ? [best.value] : undefined;
  }

  // ----------------------------------------------------------
  // ② プレイする手を選ぶ
  // ----------------------------------------------------------

  private async choosePlay<T>(engine: Engine, req: SelectRequest<T>): Promise<T[] | undefined> {
    const player = req.player;
    const candidates: (T & PlayChoice)[] = [];
    for (const o of req.options) {
      if (!isPlayChoice(o.value)) return undefined; // 形が違う（別の選択）
      candidates.push(o.value);
    }
    if (candidates.length === 0) return [];

    const n = Math.min(candidates.length, this.maxCandidates);

    let bestIndex = -1;
    let bestScore = this.passThreshold;
    for (let i = 0; i < n; i++) {
      const score = await this.scoreCandidate(engine, player, i);
      if (score === undefined) continue;
      if (bestIndex < 0 ? score > this.passThreshold : score > bestScore) {
        bestIndex = i;
        bestScore = score;
      }
    }
    if (bestIndex < 0) return []; // どれも得にならない → パス
    return [req.options[bestIndex]!.value];
  }

  /** 候補を1つ、複製した盤面で実際にプレイ＆解決して点を付ける */
  private async scoreCandidate(engine: Engine, player: PlayerId, index: number): Promise<number | undefined> {
    const sb = this.sandbox(engine);
    const before = await this.measure(sb, player);
    // 複製した盤面で同じ選択肢を作り直す（同じ状態・同じ手順なので並びは一致する）
    const options = await playChoices(sb, player);
    const choice = options[index];
    if (!choice) return undefined;

    try {
      if (choice.kind === 'card') {
        const item = await play(sb, player, choice.card);
        const stillOnStack = sb.state.stacks.some((st) => st.items.some((x) => x.uid === item.uid));
        if (stillOnStack && !sb.state.winner) {
          await resolveStackItem(topCtx(sb, player), item, false);
          await drainTriggers(sb);
        }
      } else {
        await performAlternativePlay(sb, player, choice.mod);
      }
    } catch {
      // 試し打ちで落ちる手は選ばない（本番のエンジンには影響しない）
      return undefined;
    }

    const after = await this.measure(sb, player);
    let score =
      (before.oppLife - after.oppLife) +
      (after.selfLife - before.selfLife) * this.selfLifeWeight +
      (after.objective - before.objective) * this.objectiveWeight;
    if (sb.state.winner === player) score += 1000;
    else if (sb.state.winner !== undefined) score -= 1000;
    return score;
  }

  private async measure(engine: Engine, player: PlayerId): Promise<Measured> {
    return {
      selfLife: engine.state.players[player].life,
      oppLife: engine.state.players[opponentOf(player)].life,
      objective: await objectiveScore(engine, player, this.hiddenWeight),
    };
  }

  /**
   * 試し打ち用の使い捨てエンジン。
   *
   * 盤面だけを複製し、誘発待ち（`pending`）は空から始める。
   * **プレイの選択を求められる地点では `pending` は必ず空**
   * （直前のプレイが `drainTriggers` で流し切っている）なので、取りこぼしはない。
   */
  private sandbox(engine: Engine): Engine {
    return {
      state: snapshot(engine.state),
      pool: engine.pool,
      chooser: this.fallback,
      handlers: engine.handlers,
      pending: [],
      log: [],
      depth: 0,
      budget: this.budget,
      steps: 0,
      resolving: new Set<string>(),
      targetCheckDepth: 0,
    };
  }
}

/** 「いま公開している条件・伏せている条件」を表示用にまとめる（ダッシュボード用） */
export function objectiveNames(engine: Engine, player: PlayerId): { revealed: string[]; hidden: string[] } {
  return {
    revealed: revealedObjectives(engine, player).map((o) => o.name),
    hidden: hiddenObjectives(engine, player).map((o) => o.name),
  };
}
