/**
 * 人が打つための `Chooser` と、ターミナル向けの盤面表示。
 *
 * エンジン側は一切変えていない。`Chooser` は選択の唯一の入口なので、
 * ここに人間用の実装を1つ足すだけで「自分でプレイする」が成立する。
 * `PerPlayerChooser` で AI と混ぜられ、`RecordingChooser` で包めば
 * 人の試合もそのまま記録・再生できる。
 *
 * 入力関数を差し替えられる形にしてあるので、標準入力なしでテストできる。
 */
import type {
  Chooser,
  ConfirmRequest,
  NumberRequest,
  OrderRequest,
  SelectRequest,
} from '../src/engine/chooser';
import type { Engine, LogEntry } from '../src/engine/context';
import { isPlayChoice, surrender } from '../src/engine/flow';
import { revealedObjectives } from '../src/engine/objectives';
import { objectiveProgress } from '../src/engine/progress';
import { itemName } from '../src/engine/select';
import { Scope } from '../src/engine/context';
import { opponentOf, totalMinions } from '../src/engine/state';
import type { PlayerId } from '../src/rules/types';

export interface HumanOptions {
  /** 1行読む。既定は無い（呼び出し側が readline などを渡す） */
  ask: (prompt: string) => Promise<string>;
  write?: (text: string) => void;
  /** プレイヤーの表示名（デッキ名など） */
  names?: Record<PlayerId, string>;
}

const HELP = [
  '  数字      その選択肢を選ぶ（複数選べるときは 1,3 のようにカンマ区切り）',
  '  空Enter   選ばない / パスする（選択が必須のときは無効）',
  '  b         盤面をもう一度表示する',
  '  l         ここまでのログを表示する',
  '  q         投了する',
  '  ?         このヘルプ',
];

export class HumanChooser implements Chooser {
  private engine?: Engine;
  private shown = 0;
  private readonly write: (text: string) => void;

  constructor(private readonly opts: HumanOptions) {
    this.write = opts.write ?? ((t) => console.log(t));
  }

  attach(engine: Engine): this {
    this.engine = engine;
    return this;
  }

  // ----------------------------------------------------------
  // 選択
  // ----------------------------------------------------------

  async select<T>(req: SelectRequest<T>): Promise<T[]> {
    const lines = req.options.map((o, i) => `  ${String(i + 1).padStart(2)}) ${o.label}${this.hint(o.value)}`);
    for (;;) {
      this.situation(req.player);
      this.write(`\n【${this.who(req.player)}】${req.prompt}`);
      this.write(lines.join('\n'));
      this.write(
        req.min === 0
          ? `  （空Enterで選ばない / 最大${req.max}件 / ? でヘルプ）`
          : `  （${req.min === req.max ? `${req.min}件` : `${req.min}〜${req.max}件`}選ぶ / ? でヘルプ）`,
      );

      const raw = (await this.opts.ask('> ')).trim();
      const special = await this.special(raw, req.player);
      if (special === 'again') continue;
      if (special === 'quit') return req.options.slice(0, req.min).map((o) => o.value);

      if (raw === '') {
        if (req.min === 0) return [];
        this.write('！ 選ばないことはできません');
        continue;
      }
      const picked = raw
        .split(/[,、\s]+/)
        .filter(Boolean)
        .map((s) => Number(s) - 1);
      if (picked.some((i) => !Number.isInteger(i) || i < 0 || i >= req.options.length)) {
        this.write('！ 番号が範囲外です');
        continue;
      }
      if (new Set(picked).size !== picked.length) {
        this.write('！ 同じ番号は選べません');
        continue;
      }
      if (picked.length < req.min || picked.length > req.max) {
        this.write(`！ ${req.min}〜${req.max}件を選んでください`);
        continue;
      }
      return picked.map((i) => req.options[i]!.value);
    }
  }

  async number(req: NumberRequest): Promise<number> {
    for (;;) {
      this.situation(req.player);
      this.write(`\n【${this.who(req.player)}】${req.prompt}（${req.min}〜${req.max}）`);
      const raw = (await this.opts.ask('> ')).trim();
      const special = await this.special(raw, req.player);
      if (special === 'again') continue;
      if (special === 'quit') return req.min;
      const n = Number(raw === '' ? req.min : raw);
      if (!Number.isInteger(n) || n < req.min || n > req.max) {
        this.write('！ その範囲の整数を入力してください');
        continue;
      }
      return n;
    }
  }

  async confirm(req: ConfirmRequest): Promise<boolean> {
    for (;;) {
      this.situation(req.player);
      this.write(`\n【${this.who(req.player)}】${req.prompt}  (y/n)`);
      const raw = (await this.opts.ask('> ')).trim().toLowerCase();
      const special = await this.special(raw, req.player);
      if (special === 'again') continue;
      if (special === 'quit') return false;
      if (raw === 'y' || raw === 'yes' || raw === 'はい') return true;
      if (raw === 'n' || raw === 'no' || raw === 'いいえ' || raw === '') return false;
      this.write('！ y か n で答えてください');
    }
  }

  async order<T>(req: OrderRequest<T>): Promise<T[]> {
    for (;;) {
      this.situation(req.player);
      this.write(`\n【${this.who(req.player)}】${req.prompt}`);
      this.write(req.options.map((o, i) => `  ${String(i + 1).padStart(2)}) ${o.label}`).join('\n'));
      this.write('  （処理したい順に 2,1,3 のように / 空Enterでこのまま）');
      const raw = (await this.opts.ask('> ')).trim();
      const special = await this.special(raw, req.player);
      if (special === 'again') continue;
      if (special === 'quit' || raw === '') return req.options.map((o) => o.value);

      const picked = raw
        .split(/[,、\s]+/)
        .filter(Boolean)
        .map((s) => Number(s) - 1);
      if (
        picked.length !== req.options.length ||
        new Set(picked).size !== picked.length ||
        picked.some((i) => !Number.isInteger(i) || i < 0 || i >= req.options.length)
      ) {
        this.write(`！ 1〜${req.options.length} を1回ずつ、全部並べてください`);
        continue;
      }
      return picked.map((i) => req.options[i]!.value);
    }
  }

  // ----------------------------------------------------------
  // 補助
  // ----------------------------------------------------------

  /** b / l / ? / q の処理。'again' なら選択をやり直す */
  private async special(raw: string, player: PlayerId): Promise<'again' | 'quit' | undefined> {
    const engine = this.engine;
    if (raw === '?') {
      this.write(HELP.join('\n'));
      return 'again';
    }
    if (raw === 'b') {
      if (engine) this.write(renderBoard(engine, player, this.opts.names));
      return 'again';
    }
    if (raw === 'l') {
      if (engine) this.write(engine.log.map(formatLine).join('\n'));
      return 'again';
    }
    if (raw === 'q') {
      if (engine) {
        surrender(engine, player);
        this.write(`${this.who(player)} は投了しました`);
      }
      return 'quit';
    }
    return undefined;
  }

  /** まだ見せていないログを出す（試合が終わったあとの締め用） */
  flushLog(): void {
    const engine = this.engine;
    if (!engine) return;
    const fresh = engine.log.slice(this.shown);
    this.shown = engine.log.length;
    if (fresh.length > 0) this.write(['', ...fresh.map(formatLine)].join('\n'));
  }

  /** 前回の選択から今までに起きたことと、盤面を出す */
  private situation(player: PlayerId): void {
    const engine = this.engine;
    if (!engine) return;
    const fresh = engine.log.slice(this.shown);
    this.shown = engine.log.length;
    if (fresh.length > 0) this.write('\n' + fresh.map(formatLine).join('\n'));
    this.write(renderBoard(engine, player, this.opts.names));
  }

  private who(player: PlayerId): string {
    return this.opts.names?.[player] ?? player;
  }

  /** 選択肢がカードなら、その印刷テキストを添える */
  private hint<T>(value: T): string {
    const engine = this.engine;
    if (!engine || !isPlayChoice(value) || value.kind !== 'card') return '';
    const text = engine.pool.card(value.card.defId).text.replace(/\n/g, ' / ');
    return `\n        ${text}`;
  }
}

// ============================================================
// 表示
// ============================================================

export function formatLine(e: LogEntry): string {
  return `  ${'  '.repeat(e.depth)}${e.text}`;
}

const PHASE_NAME: Record<string, string> = {
  cycleStart: '①サイクル開始',
  draw: '②ドロー',
  stack: '③スタック',
  order: '④順番確定',
  resolve: '⑤解決',
  end: '⑥終了',
};

/** `viewer` から見た盤面。相手の手札の中身と伏せた勝利条件は出さない */
export function renderBoard(engine: Engine, viewer: PlayerId, names?: Record<PlayerId, string>): string {
  const s = engine.state;
  const foe = opponentOf(viewer);
  const label = (p: PlayerId): string => `${p} ${names?.[p] ?? s.players[p].god}`;
  const out: string[] = [];

  const head = `サイクル ${s.cycle} / ${PHASE_NAME[s.phase] ?? s.phase}フェイズ / 天候 ${s.weather}${s.apocalypse ? '+終末' : ''} / 先攻 ${s.first}`;
  out.push('\n' + '─'.repeat(4) + ` ${head} ` + '─'.repeat(4));
  out.push(side(engine, foe, label(foe), false));

  const items = s.stacks.flatMap((st) => st.items);
  if (items.length === 0) out.push('  スタック: なし');
  else {
    out.push('  スタック（上から解決）');
    [...items].reverse().forEach((it, i) => {
      const ctx = { engine, self: it.controller, item: it, stackId: it.stackId, vars: new Scope() };
      const chant = it.counters.chant ? `  詠唱${it.counters.chant}` : '';
      out.push(`    ${items.length - i} [${it.controller}] ${itemName(ctx, it)}${chant}`);
    });
  }

  out.push(side(engine, viewer, label(viewer), true));
  return out.join('\n');
}

function side(engine: Engine, pid: PlayerId, label: string, own: boolean): string {
  const p = engine.state.players[pid];
  const minions = Object.entries(p.minions).filter(([, n]) => n > 0);
  const tokens = p.tokens.filter((t) => t.equipped).map((t) => engine.pool.token(t.defId).name);
  const status = (['evasion', 'shield', 'reduction', 'armor'] as const)
    .filter((k) => p.status[k] > 0)
    .map((k) => `${k}${p.status[k]}`);

  const bits = [
    `ライフ ${String(p.life).padStart(3)}`,
    `手札 ${p.zones.hand[0]?.length ?? 0}`,
    `山 ${p.zones.deck.reduce((a, d) => a + d.length, 0)}`,
    `墓地 ${p.zones.graveyard[0]?.length ?? 0}`,
  ];
  if (minions.length > 0) bits.push(`ミニオン ${minions.map(([sp, n]) => `${sp}${n}`).join(' ')}`);
  if (tokens.length > 0) bits.push(`装備 ${tokens.join(' ')}`);
  if (status.length > 0) bits.push(status.join(' '));

  const lines = [`  ${own ? '▼' : '△'} ${label}  ${bits.join('  ')}`];
  for (const o of revealedObjectives(engine, pid)) {
    lines.push(`      公開: ${o.name}（先行度${o.initiative}）`);
  }
  if (own) {
    const hidden = engine.state.players[pid].objectives.length;
    if (hidden > 0) lines.push(`      伏せ: ${hidden}件`);
  }
  return lines.join('\n');
}

/** 自分の勝利条件の達成度（`progress.ts` を再利用）。表示は自分の分だけ */
export async function renderObjectives(engine: Engine, viewer: PlayerId): Promise<string> {
  const rows = await objectiveProgress(engine, viewer);
  return rows
    .map((r) => {
      const mark = r.revealed ? '公開' : '伏せ';
      const p = r.progress === undefined ? ' -- ' : `${String(Math.round(100 * r.progress)).padStart(3)}%`;
      return `  ${mark} ${p}  ${r.objective.name}  ${r.detail}`;
    })
    .join('\n');
}

export { totalMinions };
