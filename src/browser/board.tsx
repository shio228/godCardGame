/**
 * 対戦画面の部品。
 *
 * **画面はサーバが作ったビューを描くだけ**で、ゲームの状態は持たない
 * （持っているのは「いま選びかけの選択肢」だけ）。
 *
 * 中央にスタックを置いてあるのは、このゲームの主役がスタックだから。
 * 上に相手、下に自分と手札、右にログ、いちばん下に選択バーを固定する。
 */
import { useEffect, useMemo, useState, type JSX } from 'react';

import type { CardView, LogView, ObjectiveView, PlayerView, SideView, StackItemView } from '../engine/view';
import type { Answer, PendingRequest } from '../net/protocol';

const PHASE_NAMES: Record<string, string> = {
  draw: 'ドロー',
  stack: 'スタック',
  order: '順番確定',
  resolve: '解決',
  end: 'ターン終了',
  cleanup: '後始末',
};

const GOD_NAMES: Record<string, string> = {
  earth: '大地',
  sea: '海',
  sky: '空',
  life: '生命',
  creation: '創造',
};

export function godName(id: string): string {
  return GOD_NAMES[id] ?? id;
}

// ============================================================
// 盤面
// ============================================================

export interface BoardProps {
  view: PlayerView;
  pending?: PendingRequest | undefined;
  busy: boolean;
  waitingNote: string;
  onChoose: (answer: Answer) => void;
  onSurrender: () => void;
}

export function Board({ view, pending, busy, waitingNote, onChoose, onSurrender }: BoardProps): JSX.Element {
  // 手札を直接押して選べるのは「プレイするカードを選ぶ」のときだけ。
  // 「手札からn枚選ぶ」でも押せるようにすると、1枚目を押した瞬間に送信されて
  // 選び終わる前に次へ進んでしまう（テラブレイズで発覚）
  const playable = useMemo(() => new Set(pending?.play === true ? (pending.options ?? []) : []), [pending]);

  return (
    <div className="board">
      <div className="board-main">
        <Side side={view.opp} facing="opp" />

        <div className="middle">
          <div className="tape">
            <span className="tape-item">サイクル {view.cycle}</span>
            <span className="tape-item">ターン {view.turn}</span>
            <span className="tape-item">{PHASE_NAMES[view.phase] ?? view.phase}フェイズ</span>
            <span className="tape-item weather">天候: {view.weather}</span>
            {view.apocalypse ? <span className="tape-item crit">終焉</span> : null}
            <span className="tape-item muted">先攻: {view.first === view.you ? 'あなた' : '相手'}</span>
          </div>
          <Stacks stacks={view.stacks} you={view.you} />
        </div>

        <Side side={view.me} facing="me" />
        <Hand
          cards={view.me.hand ?? []}
          playable={playable}
          onPlay={(label) => {
            const i = (pending?.options ?? []).indexOf(label);
            if (i >= 0 && !busy) onChoose([i]);
          }}
        />
      </div>

      <aside className="rail">
        <Log log={view.log} />
      </aside>

      <ChoiceBar
        pending={pending}
        busy={busy}
        waitingNote={waitingNote}
        onChoose={onChoose}
        onSurrender={onSurrender}
      />
    </div>
  );
}

// ============================================================

function Side({ side, facing }: { side: SideView; facing: 'me' | 'opp' }): JSX.Element {
  const minions = side.minions.reduce((a, m) => a + m.count, 0);
  return (
    <section className={`side side-${facing}`}>
      <header className="side-head">
        <span className={`who ${facing}`}>{facing === 'me' ? 'あなた' : '相手'}</span>
        <strong>{side.name}</strong>
        <span className="god">{godName(side.god)}</span>
        <span className="life" title="ライフ">
          ♥ {side.life}
        </span>
      </header>

      <div className="counts">
        <Count label="手札" n={side.handCount} />
        <Count label="山札" n={side.deckCount} />
        <Count label="墓地" n={side.graveyardCount} />
        <Count label="追放" n={side.exileCount} />
        {side.foresightCount > 0 ? <Count label="予知" n={side.foresightCount} /> : null}
        {minions > 0 ? <Count label="ミニオン" n={minions} /> : null}
      </div>

      {side.minions.length > 0 ? (
        <div className="chips">
          {side.minions.map((m) => (
            <span className="chip" key={m.species}>
              {m.species} × {m.count}
            </span>
          ))}
        </div>
      ) : null}

      {side.tokens.length > 0 ? (
        <div className="chips">
          {side.tokens.map((t, i) => (
            <span className={`chip ${t.equipped ? 'equipped' : ''}`} key={`${t.name}-${i}`}>
              {t.name}
              {t.equipped ? '（装備）' : ''}
            </span>
          ))}
        </div>
      ) : null}

      <Statuses side={side} />
      <Objectives revealed={side.revealed} hidden={side.hidden} hiddenCount={side.hiddenCount} />
    </section>
  );
}

function Count({ label, n }: { label: string; n: number }): JSX.Element {
  return (
    <span className="count">
      <span className="count-label">{label}</span>
      <span className="count-n">{n}</span>
    </span>
  );
}

function Statuses({ side }: { side: SideView }): JSX.Element | null {
  const items = [
    ...Object.entries(side.status).filter(([, n]) => n > 0),
    ...Object.entries(side.counters).filter(([, n]) => n > 0),
  ];
  if (items.length === 0) return null;
  return (
    <div className="chips">
      {items.map(([k, n]) => (
        <span className="chip status" key={k}>
          {k} {n}
        </span>
      ))}
    </div>
  );
}

function Objectives({
  revealed,
  hidden,
  hiddenCount,
}: {
  revealed: ObjectiveView[];
  hidden?: ObjectiveView[] | undefined;
  hiddenCount: number;
}): JSX.Element {
  const list = [...revealed.map((o) => ({ o, open: true })), ...(hidden ?? []).map((o) => ({ o, open: false }))];
  return (
    <div className="objectives">
      {list.map(({ o, open }) => (
        <div className={`objective ${open ? 'open' : 'closed'}`} key={o.id} title={o.text}>
          <span className="objective-name">
            {open ? '公開' : '伏せ'} {o.name}
          </span>
          <span className="objective-detail">{o.detail}</span>
          <span className="gauge">
            <i style={{ width: `${Math.round((o.progress ?? 0) * 100)}%` }} />
          </span>
        </div>
      ))}
      {hidden === undefined && hiddenCount > 0 ? <div className="objective closed">伏せ {hiddenCount} 件</div> : null}
    </div>
  );
}

function Stacks({ stacks, you }: { stacks: PlayerView['stacks']; you: string }): JSX.Element {
  if (stacks.length === 0) return <div className="stacks empty">スタックは空</div>;
  return (
    <div className="stacks">
      {stacks.map((s) => (
        <div className="stack" key={s.id}>
          <div className="stack-head">
            {s.id}
            <span className="muted"> / {s.items.length}枚</span>
          </div>
          {s.items.map((it) => (
            <Item item={it} you={you} key={it.uid} />
          ))}
        </div>
      ))}
    </div>
  );
}

function Item({ item, you }: { item: StackItemView; you: string }): JSX.Element {
  const mine = item.controller === you;
  // 手札のカードと同じで、カーソルを合わせると効果が読める
  const tip = [item.types?.join(' / '), item.text].filter((x) => x !== undefined && x !== '').join('\n');
  return (
    <div
      className={`item ${mine ? 'mine' : 'theirs'} ${item.immovable ? 'immovable' : ''}`}
      {...(tip === '' ? {} : { title: tip })}
    >
      <span className="item-name">{item.name}</span>
      {item.chant !== undefined && item.chant > 0 ? <span className="chant">詠唱 {item.chant}</span> : null}
    </div>
  );
}

function Hand({
  cards,
  playable,
  onPlay,
}: {
  cards: CardView[];
  playable: Set<string>;
  onPlay: (label: string) => void;
}): JSX.Element {
  return (
    <div className="hand">
      {cards.length === 0 ? <div className="muted">手札なし</div> : null}
      {cards.map((c) => {
        const can = playable.has(c.name);
        return (
          <button
            className={`card ${can ? 'playable' : ''}`}
            key={c.uid}
            disabled={!can}
            onClick={() => onPlay(c.name)}
            title={c.text}
          >
            <span className="card-name">{c.name}</span>
            <span className="card-types">{c.types.join(' / ')}</span>
            <span className="card-text">{c.text}</span>
          </button>
        );
      })}
    </div>
  );
}

function Log({ log }: { log: LogView[] }): JSX.Element {
  return (
    <div className="log">
      <div className="log-head">ログ</div>
      <div className="log-body">
        {log.map((e, i) => (
          <div className={`line depth-${Math.min(e.depth, 4)} kind-${e.kind ?? 'other'}`} key={i}>
            {e.text}
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// 選択バー
// ============================================================

export function ChoiceBar({
  pending,
  busy,
  waitingNote,
  onChoose,
  onSurrender,
}: {
  pending?: PendingRequest | undefined;
  busy: boolean;
  waitingNote: string;
  onChoose: (answer: Answer) => void;
  onSurrender: () => void;
}): JSX.Element {
  const [picked, setPicked] = useState<number[]>([]);
  const [num, setNum] = useState(0);

  const key = pending ? `${pending.index}:${pending.prompt}` : 'none';
  const lo = pending?.min ?? 0;
  useEffect(() => {
    setPicked([]);
    setNum(lo);
  }, [key, lo]);

  if (!pending) {
    return (
      <div className="choice waiting">
        <span className="spinner" aria-hidden="true" />
        <span>{waitingNote}</span>
        <button className="ghost danger" onClick={onSurrender}>
          投了
        </button>
      </div>
    );
  }

  const options = pending.options ?? [];
  const min = pending.min ?? 0;
  const max = pending.max ?? options.length;

  if (pending.t === 'confirm') {
    return (
      <div className="choice">
        <span className="prompt">{pending.prompt}</span>
        <button className="primary" disabled={busy} onClick={() => onChoose(true)}>
          はい
        </button>
        <button disabled={busy} onClick={() => onChoose(false)}>
          いいえ
        </button>
      </div>
    );
  }

  if (pending.t === 'number') {
    const hi = pending.max ?? lo;
    return (
      <div className="choice">
        <span className="prompt">
          {pending.prompt}
          <span className="muted">
            （{lo}〜{hi}）
          </span>
        </span>
        <input type="number" value={num} min={lo} max={hi} onChange={(e) => setNum(Number(e.target.value))} />
        <button className="primary" disabled={busy || num < lo || num > hi} onClick={() => onChoose(num)}>
          決定
        </button>
      </div>
    );
  }

  const ordering = pending.t === 'order';
  const done = ordering ? picked.length === options.length : picked.length >= min && picked.length <= max;

  // ちょうど1件を選ぶ問いは、押した時点で送る（確認の一手間が要らない）
  const single = !ordering && min === 1 && max === 1;

  const toggle = (i: number): void => {
    if (single) {
      onChoose([i]);
      return;
    }
    setPicked((cur) => {
      if (cur.includes(i)) return cur.filter((x) => x !== i);
      if (!ordering && cur.length >= max) return max === 1 ? [i] : cur;
      return [...cur, i];
    });
  };

  return (
    <div className="choice">
      <span className="prompt">
        {pending.prompt}
        <span className="muted">
          {ordering
            ? '（上から解決される順に押す）'
            : min === 1 && max === 1
              ? '（1件・押すと決まる）'
              : min === max
                ? `（${min}件）`
                : `（${min}〜${max}件）`}
        </span>
      </span>
      <div className="options">
        {options.map((label, i) => {
          const at = picked.indexOf(i);
          return (
            <button
              className={`option ${at >= 0 ? 'picked' : ''}`}
              key={`${label}-${i}`}
              disabled={busy}
              onClick={() => toggle(i)}
            >
              {ordering && at >= 0 ? <span className="order-no">{at + 1}</span> : null}
              {label}
            </button>
          );
        })}
      </div>
      {single ? null : (
        <div className="choice-actions">
          {picked.length > 0 ? (
            <button className="ghost" disabled={busy} onClick={() => setPicked([])}>
              選び直す
            </button>
          ) : null}
          <button className="primary" disabled={busy || !done} onClick={() => onChoose(picked)}>
            決定
          </button>
        </div>
      )}
    </div>
  );
}
