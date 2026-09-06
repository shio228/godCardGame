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
 * ## 測り方: 「積んだ時点」と「解決後」の両方を見る
 *
 * このゲームはプレイしてもカードはスタックに乗るだけで、効果は解決フェイズまで起きない。
 * かといって**そのカードだけを即解決して測ると、スタックに積んで価値が出るものが0点になる**。
 * 「詠唱の極致（スタックの詠唱が30）」のようにスタック上でしか成立しない条件は、
 * 解決した瞬間に消えてしまうからで、これが原因で海の打ち手は
 * 「打てるのにパス」を繰り返していた（2026-09-06 のテストプレイで発覚）。
 *
 * そこで候補ごとに複製した盤面で:
 *
 *   ① その手を打つ（瞬発ならその場で解決される）→ **スタックに載った状態**で測る
 *   ② そのまま解決フェイズを回す（スタックを全部解決）→ **解決後**で測る
 *
 * 勝利条件の進捗は①と②の**良い方**を採る（条件は成立した瞬間に誘発するので、
 * どちらかの時点で満たせば勝てる）。ライフは②で測る（実際に通ったダメージ）。
 *
 * ## パスも同じ土俵で評価する
 *
 * 「何も打たずにスタックが解決したらどうなるか」を1つの候補として同じ手順で測り、
 * **それより良い手が無ければパスする**。パスはそのフェイズ中ずっとパスになる不可逆な選択なので、
 * 固定のしきい値と比べるのではなく、実際に回して比べる。
 *
 * ## 測っているもの
 *
 *   相手のライフの減り        +1.0 / 点
 *   自分のライフの増減        +selfLifeWeight / 点
 *   自分の勝利条件の進捗      +objectiveWeight / (0〜1の達成度の合計)
 *   **相手の勝利条件の進捗**  −opponentWeight / 同上（妨害を評価する）
 *   勝敗が決まるなら          ±1000
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
  resolvePhase,
  topCtx,
  type PlayChoice,
} from './flow';
import { hiddenObjectives, revealedObjectives } from './objectives';
import { objectiveScore } from './progress';
import { opponentOf, snapshot, type StackItem } from './state';

export interface GreedyOptions {
  /** 勝利条件の進捗1.0ぶんを、相手ライフ何点ぶんと見るか */
  objectiveWeight?: number;
  /** 自分のライフ1点の重み（負の値ほど自分の消耗を嫌う） */
  selfLifeWeight?: number;
  /** 伏せてある勝利条件の進捗をどれだけ見るか（0〜1） */
  hiddenWeight?: number;
  /**
   * **相手**の勝利条件の進捗をどれだけ嫌うか（妨害の重み）。
   * 相手の伏せ札は見えないので、公開済みのぶんだけを見る。
   */
  opponentWeight?: number;
  /** パスの点に足す下駄。既定0で「パスと同点なら打つ」。上げるほど打たなくなる */
  passThreshold?: number;
  /** 1回の判断で試す候補の上限（先頭から。手札が多いときの打ち切り） */
  maxCandidates?: number;
  /** 試し解決の中で使う打ち手（既定 AutoChooser）と、考えない選択の委譲先 */
  fallback?: Chooser;
  /** 試し解決に使う予算（無限ループ検出） */
  budget?: number;
  /**
   * 試し打ちのあと、どこまで回して測るか。
   *   'item'  … 打った1枚だけを解決する（相手のスタックには触らない）
   *   'stack' … 解決フェイズをそのまま回す（相手の項目も解決される）
   *   'phase' … スタックフェイズの続きを安い打ち手で打ち切ってから解決する
   *
   * 既定は **'stack'**。'phase' は「置いてから後で押し上げる」を見せるつもりで入れたが、
   * **測ったら弱くなったので既定にしていない**（下の表）。
   * 続きを埋める打ち手が雑（打てるなら手札の先頭）なので、
   * candidate ごとに違う「ありもしない続き」で採点してしまうのが原因と見ている。
   *
   * | 設定 | 変更前との勝率 | ドレッドを置いたあと押し上げた率 | 1試合の与ダメ |
   * |---|---|---|---|
   * | 'stack' + 置き点（既定） | 52.8% / 49.3% | **56%** | **23** |
   * | 'phase' 自分だけ4手 | 39.6% / 41.7% | 15% | 17 |
   * | 'phase' 自分だけ2手 | 49.3% / 45.8% | 36% | 17 |
   * | 'phase' 両者4手 | 45.1% / 47.2% | 33% | 24 |
   *
   * 直すなら続きの打ち手を賢くする（1手評価で選ばせる）ことになるが、
   * 1判断あたりの試し打ちが桁で増えるので、やるなら明示指定のモードとして。
   */
  rollout?: 'item' | 'stack' | 'phase';
  /** 'phase' で、続きに何手打たせるか（既定4） */
  rolloutPlays?: number;
  /**
   * 'phase' の続きを誰に打たせるか。
   *   'self' … **自分の続きだけ**（相手はパスしたものとみなす。既定）
   *   'both' … 相手にも打たせる
   * 相手の手は読めないので、雑な打ち手で埋めると評価が濁る（実測で弱くなった）。
   */
  rolloutSide?: 'self' | 'both';
  /**
   * **スタックに置くこと自体の価値**。
   *
   * `active:'onStack'` の能力（詠唱の閾値・常在）を持つカードを置いたときに足す。
   * カード個別の知識ではなく DSL の形から機械的に判定するので、
   * AI 側に「ドレッドは置いてから押し上げろ」とは書かない。
   *
   * これが無いと、ドレッドフル・タイダルウェイブのように
   * **置いた時点では0点で、あとから押し上げて初めて効く**カードが選ばれない。
   * 実測（海の火力デッキ20試合）: 置いた回数 4→25、押し上げ成功率 50%→56%、
   * 1試合の与ダメージ 17→23。既定1。
   */
  onStackWeight?: number;
}

interface Measured {
  selfLife: number;
  oppLife: number;
  objective: number;
  /** 相手の公開済み勝利条件の進捗（妨害の評価に使う） */
  oppObjective: number;
}

export class GreedyChooser implements Chooser {
  private readonly objectiveWeight: number;
  private readonly selfLifeWeight: number;
  private readonly hiddenWeight: number;
  private readonly opponentWeight: number;
  private readonly rollout: 'item' | 'stack' | 'phase';
  private readonly rolloutPlays: number;
  private readonly rolloutSide: 'self' | 'both';
  private readonly onStackWeight: number;
  private readonly passThreshold: number;
  private readonly maxCandidates: number;
  private readonly budget: number;
  private readonly fallback: Chooser;

  constructor(opts: GreedyOptions = {}) {
    this.objectiveWeight = opts.objectiveWeight ?? 30;
    this.selfLifeWeight = opts.selfLifeWeight ?? 0.5;
    this.hiddenWeight = opts.hiddenWeight ?? 0.5;
    this.opponentWeight = opts.opponentWeight ?? 15;
    this.rollout = opts.rollout ?? 'stack';
    this.rolloutPlays = opts.rolloutPlays ?? 4;
    this.rolloutSide = opts.rolloutSide ?? 'self';
    this.onStackWeight = opts.onStackWeight ?? 1;
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

    // パス（何も打たずにスタックが解決したら）を基準線にする
    const passScore = (await this.scoreCandidate(engine, player)) ?? 0;

    const n = Math.min(candidates.length, this.maxCandidates);
    let bestIndex = -1;
    let bestScore = passScore + this.passThreshold;
    for (let i = 0; i < n; i++) {
      const score = await this.scoreCandidate(engine, player, i);
      if (score === undefined) continue;
      // **同点ならプレイする。** パスはそのフェイズ中ずっとパスになる不可逆な選択なので、
      // 損でないかぎり打つ。強さは同等（AI同士192戦で 53.6%）だが、
      // 「打てるのに何もしない」が減って動きが自然になる
      if (score >= bestScore) {
        bestIndex = i;
        bestScore = score;
      }
    }
    if (bestIndex < 0) return []; // パスより悪い手しか無い
    return [req.options[bestIndex]!.value];
  }

  /**
   * 候補を1つ、複製した盤面で試して点を付ける。`index` を省くと**パス**の評価。
   *
   * 手を打ったあと「スタックに載った状態」で1回測り、
   * そのまま解決フェイズを回して「解決後」でもう1回測る。
   * 勝利条件の進捗は**良い方**を採る（成立した瞬間に誘発するので、どちらかで満たせば勝ち）。
   */
  private async scoreCandidate(engine: Engine, player: PlayerId, index?: number): Promise<number | undefined> {
    const sb = this.sandbox(engine);
    const before = await this.measure(sb, player);
    let played: StackItem | undefined;

    if (index !== undefined) {
      // 複製した盤面で同じ選択肢を作り直す（同じ状態・同じ手順なので並びは一致する）
      const options = await playChoices(sb, player);
      const choice = options[index];
      if (!choice) return undefined;
      try {
        if (choice.kind === 'card') played = await play(sb, player, choice.card);
        else await performAlternativePlay(sb, player, choice.mod);
      } catch {
        // 試し打ちで落ちる手は選ばない（本番のエンジンには影響しない）
        return undefined;
      }
    }

    // ① スタックに載った時点。詠唱など「スタック上でしか成立しない条件」はここでしか見えない
    const onStack = await this.measure(sb, player);

    // ② 解決したら。ダメージ・盤面の変化はここで出る
    try {
      if (!sb.state.winner) {
        if (this.rollout === 'phase') {
          // スタックフェイズの続きを安い打ち手で打ち切ってから解決する。
          // 「置いてから後で押し上げる」がここで初めて見える
          await this.continuePhase(sb, player);
          await resolvePhase(sb);
        } else if (this.rollout === 'stack') {
          await resolvePhase(sb);
        } else if (played) {
          const still = sb.state.stacks.some((st) => st.items.some((x) => x.uid === played.uid));
          if (still) await resolveStackItem(topCtx(sb, player), played, false);
        }
        await drainTriggers(sb);
      }
    } catch {
      return undefined;
    }
    const after = await this.measure(sb, player);

    const objectiveGain = Math.max(onStack.objective, after.objective) - before.objective;
    // 案3: スタック上で働く能力を持つカードは、**置くこと自体**に価値がある
    const placement = played !== undefined && hasOnStackAbility(sb, played) ? this.onStackWeight : 0;
    const oppGain = Math.max(onStack.oppObjective, after.oppObjective) - before.oppObjective;
    let score =
      (before.oppLife - after.oppLife) +
      (after.selfLife - before.selfLife) * this.selfLifeWeight +
      objectiveGain * this.objectiveWeight -
      oppGain * this.opponentWeight +
      placement;
    if (sb.state.winner === player) score += 1000;
    else if (sb.state.winner !== undefined) score -= 1000;
    return score;
  }

  /**
   * スタックフェイズの続きを打ち切る（試し打ちの中だけ）。
   *
   * 打ち手は**いちばん安いもの**——「打てるなら手札の先頭を打つ」。
   * ここで本物の評価を再帰させると候補数ぶん指数的に膨らむので、意図的に雑にしてある。
   * 見たいのは「置いた札が後から押し上げられるか」であって、続きの最善手ではない。
   */
  private async continuePhase(sb: Engine, player: PlayerId): Promise<void> {
    const both = this.rolloutSide === 'both';
    let seat = both ? opponentOf(player) : player; // 相手にも打たせるなら次は相手
    for (let k = 0; k < this.rolloutPlays; k++) {
      if (sb.state.winner) return;
      const options = await playChoices(sb, seat);
      const choice = options[0];
      if (choice) {
        if (choice.kind === 'card') await play(sb, seat, choice.card);
        else await performAlternativePlay(sb, seat, choice.mod);
        await drainTriggers(sb);
      }
      if (both) seat = opponentOf(seat);
    }
  }

  private async measure(engine: Engine, player: PlayerId): Promise<Measured> {
    const opp = opponentOf(player);
    return {
      selfLife: engine.state.players[player].life,
      oppLife: engine.state.players[opp].life,
      objective: await objectiveScore(engine, player, this.hiddenWeight),
      // 相手の伏せ札は見えないので、公開済みのぶんだけ（hiddenWeight = 0）
      oppObjective: await objectiveScore(engine, opp, 0),
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

/**
 * スタックに載っている間に働く能力を持つか（案3の判定）。
 * カード名ではなく **DSL の形**（`active:'onStack'`）で見るので、
 * AI 側に個別カードの知識が入らない。
 */
function hasOnStackAbility(engine: Engine, item: StackItem): boolean {
  if (!item.card) return false;
  const def = engine.pool.card(item.card.defId);
  return (def.abilities ?? []).some((a) => 'active' in a && a.active === 'onStack');
}

/** 「いま公開している条件・伏せている条件」を表示用にまとめる（ダッシュボード用） */
export function objectiveNames(engine: Engine, player: PlayerId): { revealed: string[]; hidden: string[] } {
  return {
    revealed: revealedObjectives(engine, player).map((o) => o.name),
    hidden: hiddenObjectives(engine, player).map((o) => o.name),
  };
}
